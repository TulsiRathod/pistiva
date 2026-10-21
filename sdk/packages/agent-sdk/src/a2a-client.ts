import { randomUUID } from "node:crypto";
import {
  A2A_PATH,
  dataPart,
  PISTIVA_TRUST,
  PISTIVA_TRUST_EXTENSION,
  singleDataPart,
  taskEnvelope,
  type A2AMessage,
  type A2ATask,
  type JsonRpcError,
  type JsonRpcResponse,
  type MessageTrust,
  type Part,
  type TaskTrust,
} from "./a2a.ts";
import { ContractRegistry } from "./contracts.ts";
import { buildEnvelope, countersign, requestHash, responseHash, verifyEnvelope, verifyReceiptSignature } from "./envelope.ts";
import { signJws, VerificationError } from "./jws.ts";
import type { AgentKeyPair } from "./keys.ts";
import type { PlatformClient } from "./platform-client.ts";
import {
  AGENT_ASSERTION_TYP,
  type DiscoveredAgent,
  type Envelope,
  type IssuedGrant,
  type MessageKind,
  type SignedReceipt,
  type TaskState,
} from "./protocol.ts";
import { TASKS_PATH } from "./task-client.ts";

export interface Clarification {
  question: string;
  field?: string;
  options?: string[];
}

/** Answers a provider's clarifying question; return null to cancel the task instead. */
export type ClarificationHandler = (
  clarification: Clarification,
  ctx: { taskId: string; round: number; provider: DiscoveredAgent },
) => Promise<{ answer: string } | null> | { answer: string } | null;

export interface RoundRecord {
  round: number;
  state: TaskState;
  receipt: SignedReceipt;
  /** Whether the platform accepted the countersigned receipt. */
  recorded: boolean;
}

export interface A2AOutcome<R> {
  taskId: string;
  state: TaskState;
  result?: R;
  /** Provider's explanation when the task failed or was rejected. */
  reason?: string;
  rounds: RoundRecord[];
  grants: IssuedGrant[];
  approvalRequired: boolean;
  /** Only direct HTTPS exists in this milestone; relay comes with P2P. */
  connection: "direct";
}

export class A2AError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "A2AError";
  }
}

export interface A2AClientOptions {
  platform: PlatformClient;
  keys: AgentKeyPair;
  contracts?: ContractRegistry;
  maxAttempts?: number;
  timeoutMs?: number;
  /** Renew the grant (same task) when it has fewer than this many seconds left. */
  grantRenewalSeconds?: number;
  /** Upper bound on clarification rounds, so a provider cannot keep a task open forever. */
  maxRounds?: number;
  /** Called when the platform issues (or renews) the task's grant, before any message is sent. */
  onGrant?(grant: IssuedGrant, provider: DiscoveredAgent): Promise<void> | void;
  /** Called after each verified round, e.g. so an operator UI can show the exchange. */
  onRound?(event: OutboundRound): Promise<void> | void;
}

export interface OutboundRound {
  taskId: string;
  grant: IssuedGrant;
  round: number;
  kind: MessageKind;
  sent: Record<string, unknown>;
  task: A2ATask;
  record: RoundRecord;
}

/**
 * Requester side of an A2A task under the pistiva-trust extension: grant, signed message, verified and
 * countersigned reply per round, clarification answers, and receipts recorded on the platform.
 * Message contents go straight to the provider; the platform only sees hashes.
 */
export class A2AClient {
  private readonly contracts: ContractRegistry;

  constructor(private readonly opts: A2AClientOptions) {
    this.contracts = opts.contracts ?? new ContractRegistry(opts.platform);
  }

  async run<Req extends Record<string, unknown>, Res = Record<string, unknown>>(
    provider: DiscoveredAgent,
    capability: string,
    request: Req,
    spend: { budget: string; currency: string; approvalId?: string },
    onClarification?: ClarificationHandler,
  ): Promise<A2AOutcome<Res>> {
    const { platform } = this.opts;
    const version = provider.card.capabilities.find((c) => c.name === capability)?.version;
    if (version === undefined) throw new Error(`${provider.orgName} does not offer ${capability}`);
    // Fail before spending a grant if our own request breaks the contract.
    await this.contracts.validate(capability, version, "request", request);

    let grant = await platform.requestGrant({ providerAgentId: provider.agentId, capability, ...spend });
    await this.opts.onGrant?.(grant, provider);
    const grants = [grant];
    const rounds: RoundRecord[] = [];
    const base: Omit<A2AOutcome<Res>, "state"> = { taskId: grant.taskId, rounds, grants, approvalRequired: grant.approvalRequired, connection: "direct" };

    let kind: MessageKind = "request";
    let data: Record<string, unknown> = request;
    for (let round = 1; round <= (this.opts.maxRounds ?? 5); round++) {
      if (Date.parse(grant.expiresAt) - Date.now() < (this.opts.grantRenewalSeconds ?? 60) * 1000) {
        grant = await platform.requestGrant({ providerAgentId: provider.agentId, capability, budget: spend.budget, currency: spend.currency, continueTaskId: grant.taskId });
        grants.push(grant);
        await this.opts.onGrant?.(grant, provider);
      }
      const task = await this.sendRound(provider, grant, capability, kind, round, data);
      const record = await this.settleReceipt(provider, task);
      rounds.push(record);
      await this.opts.onRound?.({ taskId: grant.taskId, grant, round, kind, sent: data, task, record });

      const state = task.status.state;
      const replyData = singleDataPart(task.status.message?.parts);
      if (state === "completed") {
        // The provider's output is untrusted input to us: check it against the contract too.
        await this.contracts.validate(capability, version, "result", replyData);
        return { ...base, state, result: replyData as Res };
      }
      if (state !== "input-required") {
        const reason = task.status.message?.parts.find((p) => p.kind === "text");
        return { ...base, state, reason: reason?.kind === "text" ? reason.text : undefined };
      }
      await this.contracts.validate(capability, version, "clarification", replyData);
      const answer = await onClarification?.(replyData as unknown as Clarification, { taskId: grant.taskId, round, provider });
      if (!answer) {
        await this.cancel(provider, grant.taskId).catch(() => undefined);
        return { ...base, state: "canceled", reason: "Requester declined to answer the clarification" };
      }
      await this.contracts.validate(capability, version, "answer", answer);
      kind = "answer";
      data = answer;
    }
    await this.cancel(provider, grant.taskId).catch(() => undefined);
    return { ...base, state: "canceled", reason: "Too many clarification rounds" };
  }

  /** Reads the latest state of a task this agent requested. */
  async getTask(provider: DiscoveredAgent, taskId: string): Promise<A2ATask> {
    return this.rpc<A2ATask>(provider, "tasks/get", { id: taskId }, this.bearer(provider));
  }

  async cancel(provider: DiscoveredAgent, taskId: string): Promise<A2ATask> {
    return this.rpc<A2ATask>(provider, "tasks/cancel", { id: taskId }, this.bearer(provider));
  }

  private async sendRound(
    provider: DiscoveredAgent,
    grant: IssuedGrant,
    capability: string,
    kind: MessageKind,
    round: number,
    data: Record<string, unknown>,
  ): Promise<A2ATask> {
    const { platform, keys } = this.opts;
    const parts: Part[] = [dataPart(data, kind)];
    // Same key for every attempt of this round, so a retried round is executed once.
    const idempotencyKey = randomUUID();
    const sent: Envelope<Part[]>[] = [];
    let lastError: unknown;
    for (let attempt = 1; attempt <= (this.opts.maxAttempts ?? 3); attempt++) {
      const envelope = buildEnvelope(
        { from: platform.agentId, to: provider.agentId, kid: platform.kid, taskId: grant.taskId, capability, idempotencyKey, body: parts, grant: grant.grant, kind, round },
        keys,
      );
      sent.push(envelope);
      const message: A2AMessage = {
        kind: "message",
        messageId: envelope.header.msgId,
        role: "user",
        parts,
        contextId: grant.taskId,
        ...(round > 1 ? { taskId: grant.taskId } : {}),
        extensions: [PISTIVA_TRUST_EXTENSION],
        metadata: { [PISTIVA_TRUST]: { header: envelope.header, signature: envelope.signature } satisfies MessageTrust },
      };
      try {
        const task = await this.rpc<A2ATask>(provider, "message/send", { message });
        await this.verifyReply(provider, grant, round, sent, task);
        return task;
      } catch (e) {
        // Retry only transport failures; a JSON-RPC error or a bad signature is a decision, not a glitch.
        if (e instanceof A2AError || e instanceof VerificationError) throw e;
        lastError = e;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Provider unreachable");
  }

  /** The reply must be addressed to one of our attempts, signed by a live provider key, and carry a matching receipt. */
  private async verifyReply(provider: DiscoveredAgent, grant: IssuedGrant, round: number, sent: Envelope<Part[]>[], task: A2ATask) {
    const envelope = taskEnvelope(task);
    const h = envelope?.header;
    const request = sent.find((s) => s.header.msgId === h?.inReplyTo);
    if (!envelope || !h || !request || h.from !== provider.agentId || h.to !== request.header.from || h.taskId !== grant.taskId || h.round !== round || task.id !== grant.taskId) {
      throw new VerificationError("Reply is not addressed to this request", "bad_response");
    }
    const status = await this.opts.platform.agentStatus(provider.agentId);
    const key = status.keys.find((k) => k.kid === h.kid && !k.revoked);
    if (!key || status.status !== "ACTIVE" || !status.orgTrusted) {
      throw new VerificationError("Provider key is revoked or provider is no longer trusted", "untrusted_provider");
    }
    verifyEnvelope(envelope, key.publicKey);
    const signed = (task.metadata?.[PISTIVA_TRUST] as TaskTrust).receipt;
    const r = signed?.receipt;
    if (
      !r ||
      r.taskId !== grant.taskId ||
      r.round !== round ||
      r.state !== task.status.state ||
      r.grantId !== grant.jti ||
      r.requestHash !== requestHash(request) ||
      r.responseHash !== responseHash(envelope.body) ||
      signed.providerKid !== key.kid ||
      !verifyReceiptSignature(r, key.publicKey, signed.providerSignature)
    ) {
      throw new VerificationError("Provider receipt does not match the exchange", "bad_receipt");
    }
  }

  private async settleReceipt(provider: DiscoveredAgent, task: A2ATask): Promise<RoundRecord> {
    const { platform, keys } = this.opts;
    const signed = countersign((task.metadata?.[PISTIVA_TRUST] as TaskTrust).receipt, platform.kid, keys);
    const recorded = await platform.submitReceipt(signed).then(
      () => true,
      () => false,
    );
    await fetch(`${provider.card.endpoint.replace(/\/$/, "")}${TASKS_PATH}/${task.id}/receipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signed),
    }).catch(() => undefined);
    return { round: signed.receipt.round, state: signed.receipt.state, receipt: signed, recorded };
  }

  private bearer(provider: DiscoveredAgent): string {
    const now = Math.floor(Date.now() / 1000);
    const { platform, keys } = this.opts;
    return signJws(AGENT_ASSERTION_TYP, platform.kid, { iss: platform.agentId, aud: provider.agentId, iat: now, exp: now + 60, jti: randomUUID() }, keys);
  }

  private async rpc<T>(provider: DiscoveredAgent, method: string, params: unknown, bearer?: string): Promise<T> {
    const res = await fetch(provider.card.endpoint.replace(/\/$/, "") + A2A_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-A2A-Extensions": PISTIVA_TRUST_EXTENSION,
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (res.status >= 500) throw new Error(`Provider returned HTTP ${res.status}`);
    const body = (await res.json()) as JsonRpcResponse<T>;
    if ("error" in body) {
      const err: JsonRpcError = body.error;
      throw new A2AError(err.code, err.message, err.data);
    }
    return body.result;
  }
}
