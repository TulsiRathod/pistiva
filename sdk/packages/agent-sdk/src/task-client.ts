import { randomUUID } from "node:crypto";
import { buildEnvelope, countersign, requestHash, responseHash, verifyEnvelope, verifyReceiptSignature } from "./envelope.ts";
import { VerificationError } from "./jws.ts";
import type { AgentKeyPair } from "./keys.ts";
import type { PlatformClient } from "./platform-client.ts";
import type { DiscoveredAgent, Envelope, IssuedGrant, SignedReceipt, TaskError, TaskResponse } from "./protocol.ts";

export const TASKS_PATH = "/pistiva/v1/tasks";

export interface TaskClientOptions {
  platform: PlatformClient;
  keys: AgentKeyPair;
  maxAttempts?: number;
  timeoutMs?: number;
}

export interface TaskOutcome<R> {
  taskId: string;
  grant: IssuedGrant;
  result: R;
  receipt: SignedReceipt;
  /** Whether the platform accepted the countersigned receipt. */
  recorded: boolean;
  /** Transport used. Only direct HTTPS exists in this milestone; relay comes with P2P. */
  connection: "direct";
  attempts: number;
}

export class TaskRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TaskRejectedError";
  }
}

/**
 * Requester side of a task: obtain a grant, send a signed request straight to the provider,
 * verify the signed response and receipt, countersign, and record the receipt hashes.
 * The request and response bodies never pass through the platform.
 */
export class TaskClient {
  constructor(private readonly opts: TaskClientOptions) {}

  async request<B, R>(
    provider: DiscoveredAgent,
    capability: string,
    body: B,
    spend: { budget: string; currency: string },
  ): Promise<TaskOutcome<R>> {
    const { platform, keys } = this.opts;
    const grant = await platform.requestGrant({
      providerAgentId: provider.agentId,
      capability,
      budget: spend.budget,
      currency: spend.currency,
    });
    // One idempotency key for the whole task: every retry is re-signed with a fresh nonce but the
    // same key, so the provider performs the work at most once.
    const idempotencyKey = randomUUID();
    const url = provider.card.endpoint.replace(/\/$/, "") + TASKS_PATH;
    const maxAttempts = this.opts.maxAttempts ?? 3;

    let lastError: unknown;
    // A retry may be answered with the cached response to an earlier attempt, so keep every request sent.
    const sent: Envelope[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const request = buildEnvelope(
        { from: platform.agentId, to: provider.agentId, kid: platform.kid, taskId: grant.taskId, capability, idempotencyKey, body, grant: grant.grant },
        keys,
      );
      sent.push(request);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
        });
      } catch (e) {
        lastError = e;
        continue;
      }
      if (res.status >= 500) {
        lastError = new TaskRejectedError(res.status, "provider_error", await res.text());
        continue;
      }
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as Partial<TaskError>;
        throw new TaskRejectedError(res.status, err.error ?? "rejected", err.message ?? `Provider rejected the task (${res.status})`);
      }
      const response = (await res.json()) as TaskResponse<R>;
      await this.verifyResponse(provider, grant, sent, response);
      const signed = countersign(response.receipt, platform.kid, keys);
      const recorded = await platform.submitReceipt(signed).then(
        () => true,
        () => false,
      );
      await fetch(`${url}/${grant.taskId}/receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signed),
      }).catch(() => undefined);
      return { taskId: grant.taskId, grant, result: response.envelope.body, receipt: signed, recorded, connection: "direct", attempts: attempt };
    }
    throw lastError instanceof Error ? lastError : new Error("Provider unreachable");
  }

  /** Treat the provider's reply as untrusted until its signature, addressing and receipt all check out. */
  private async verifyResponse(provider: DiscoveredAgent, grant: IssuedGrant, sent: Envelope[], response: TaskResponse) {
    const env = response?.envelope;
    const h = env?.header;
    const request = sent.find((s) => s.header.msgId === h?.inReplyTo);
    if (!h || !request || h.from !== provider.agentId || h.to !== request.header.from || h.taskId !== grant.taskId) {
      throw new VerificationError("Response is not addressed as a reply to this request", "bad_response");
    }
    const status = await this.opts.platform.agentStatus(provider.agentId);
    const key = status.keys.find((k) => k.kid === h.kid && !k.revoked);
    if (!key || status.status !== "ACTIVE" || !status.orgTrusted) {
      throw new VerificationError("Provider key is revoked or provider is no longer trusted", "untrusted_provider");
    }
    verifyEnvelope(env, key.publicKey);

    const r = response.receipt?.receipt;
    if (
      !r ||
      r.taskId !== grant.taskId ||
      r.grantId !== grant.jti ||
      r.requestHash !== requestHash(request) ||
      r.responseHash !== responseHash(env.body) ||
      response.receipt.providerKid !== key.kid ||
      !verifyReceiptSignature(r, key.publicKey, response.receipt.providerSignature)
    ) {
      throw new VerificationError("Provider receipt does not match the exchange", "bad_receipt");
    }
  }
}
