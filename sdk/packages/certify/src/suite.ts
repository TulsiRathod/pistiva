import { randomUUID } from "node:crypto";
import {
  A2A_PATH,
  A2AClient,
  AGENT_ASSERTION_TYP,
  AGENT_CARD_PATH,
  buildEnvelope,
  canonicalBytes,
  ContractRegistry,
  countersign,
  dataPart,
  fromB64url,
  PISTIVA_TRUST,
  PISTIVA_TRUST_EXTENSION,
  requestHash,
  responseHash,
  RpcErrors,
  signJws,
  taskEnvelope,
  TASKS_PATH,
  verifyBytes,
  verifyEnvelope,
  verifyReceiptSignature,
  type A2AAgentCard,
  type A2AMessage,
  type A2ATask,
  type AgentKeyPair,
  type DiscoveredAgent,
  type Envelope,
  type IssuedGrant,
  type Part,
  type PlatformClient,
  type TaskTrust,
} from "@pistiva/agent-sdk";

export const SUITE_VERSION = "1.0.0";

/** Requests a well-behaved partner can complete; a partner certifies other task types by passing its own sample. */
export const DEFAULT_SAMPLES: Record<string, Record<string, unknown>> = {
  "quote.request": { sku: "BOLT-M8-50", qty: 10 },
};

export interface CheckResult {
  id: string;
  title: string;
  passed: boolean;
  detail?: string;
  durationMs: number;
}

/** What the platform records. It holds probe outcomes only, never the partner's keys or private data. */
export interface ConformanceReport {
  suiteVersion: string;
  agentId: string;
  orgId: string;
  capability: string;
  taskTypeVersion: number;
  endpoint: string;
  certifierAgentId: string;
  startedAt: string;
  finishedAt: string;
  passed: boolean;
  checks: CheckResult[];
}

export interface ConformanceOptions {
  /** The certifier's platform client; its agent requests the grants the probes use. */
  platform: PlatformClient;
  keys: AgentKeyPair;
  provider: DiscoveredAgent;
  capability: string;
  sample?: Record<string, unknown>;
  spend?: { budget: string; currency: string };
  timeoutMs?: number;
  /** Called as each check finishes, e.g. to print progress. */
  onCheck?(check: CheckResult): void;
}

interface RpcReply {
  result?: A2ATask;
  error?: { code: number; message: string };
}

class CheckFailed extends Error {}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailed(message);
}

function expectError(reply: RpcReply, codes: number[], what: string): string {
  expect(reply.error, `${what} was accepted`);
  expect(codes.includes(reply.error.code), `${what} was rejected with code ${reply.error.code} (${reply.error.message}); expected ${codes.join(" or ")}`);
  return `rejected: ${reply.error.message}`;
}

/**
 * Runs the conformance suite against one partner agent and one capability. Every probe is a real,
 * granted A2A exchange from the certifier's agent, so the partner is tested exactly as it is reached
 * in production. Tasks a probe leaves waiting are canceled at the end.
 */
export async function runConformance(opts: ConformanceOptions): Promise<ConformanceReport> {
  const { platform, keys, provider, capability } = opts;
  const endpoint = provider.card.endpoint.replace(/\/$/, "");
  const version = provider.card.capabilities.find((c) => c.name === capability)?.version;
  if (version === undefined) throw new Error(`Agent ${provider.agentId} does not advertise ${capability}`);
  const sample = opts.sample ?? DEFAULT_SAMPLES[capability];
  if (!sample) throw new Error(`No sample request for ${capability}; pass one the partner can complete`);
  const spend = opts.spend ?? { budget: "1.00", currency: "INR" };
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const contracts = new ContractRegistry(platform);
  const openTasks = new Set<string>();
  const checks: CheckResult[] = [];
  const startedAt = new Date().toISOString();

  async function check(id: string, title: string, fn: () => Promise<string | void>): Promise<void> {
    const t0 = Date.now();
    let result: CheckResult;
    try {
      const detail = await fn();
      result = { id, title, passed: true, ...(detail ? { detail } : {}), durationMs: Date.now() - t0 };
    } catch (e) {
      result = { id, title, passed: false, detail: e instanceof Error ? e.message : String(e), durationMs: Date.now() - t0 };
    }
    checks.push(result);
    opts.onCheck?.(result);
  }

  async function rpc(method: string, params: unknown, bearer?: string): Promise<RpcReply> {
    const res = await fetch(endpoint + A2A_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-A2A-Extensions": PISTIVA_TRUST_EXTENSION, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => undefined)) as RpcReply | undefined;
    expect(body && (body.result || body.error), `${method} returned HTTP ${res.status} without a JSON-RPC response`);
    return body;
  }

  const grant = () => platform.requestGrant({ providerAgentId: provider.agentId, capability, ...spend });

  function signed(
    g: IssuedGrant,
    data: Record<string, unknown>,
    o: { idempotencyKey?: string; ttlSeconds?: number; capability?: string } = {},
  ): { message: A2AMessage; envelope: Envelope<Part[]> } {
    const parts: Part[] = [dataPart(data, "request")];
    const envelope = buildEnvelope(
      {
        from: platform.agentId,
        to: provider.agentId,
        kid: platform.kid,
        taskId: g.taskId,
        capability: o.capability ?? capability,
        idempotencyKey: o.idempotencyKey ?? randomUUID(),
        body: parts,
        grant: g.grant,
        kind: "request",
        round: 1,
        ...(o.ttlSeconds !== undefined ? { ttlSeconds: o.ttlSeconds } : {}),
      },
      keys,
    );
    const message: A2AMessage = {
      kind: "message",
      messageId: envelope.header.msgId,
      role: "user",
      parts,
      contextId: g.taskId,
      extensions: [PISTIVA_TRUST_EXTENSION],
      metadata: { [PISTIVA_TRUST]: { header: envelope.header, signature: envelope.signature } },
    };
    return { message, envelope };
  }

  function bearer(): string {
    const now = Math.floor(Date.now() / 1000);
    return signJws(AGENT_ASSERTION_TYP, platform.kid, { iss: platform.agentId, aud: provider.agentId, iat: now, exp: now + 60, jti: randomUUID() }, keys);
  }

  function track(reply: RpcReply, taskId: string): void {
    if (reply.result?.status.state === "input-required" || reply.result?.status.state === "working") openTasks.add(taskId);
  }

  // --- Agent card -------------------------------------------------------------------------------
  let served: A2AAgentCard | undefined;
  await check("card.a2a", "Serves an A2A agent card for this capability", async () => {
    const res = await fetch(endpoint + AGENT_CARD_PATH, { signal: AbortSignal.timeout(timeoutMs) });
    expect(res.ok, `${AGENT_CARD_PATH} returned HTTP ${res.status}`);
    served = (await res.json()) as A2AAgentCard;
    expect(typeof served.protocolVersion === "string", "protocolVersion is missing");
    expect(served.preferredTransport === "JSONRPC", `preferredTransport is ${served.preferredTransport}, expected JSONRPC`);
    expect(served.url?.replace(/\/$/, "") === endpoint + A2A_PATH, `url is ${served.url}, expected ${endpoint + A2A_PATH}`);
    const skill = `${capability}@${version}`;
    expect(served.skills?.some((s) => s.id === skill), `no skill ${skill}`);
    return `A2A ${served.protocolVersion}, skill ${skill}`;
  });

  await check("card.trust-extension", "Requires pistiva-trust and serves the card registered on the platform", async () => {
    expect(served, "no agent card to inspect");
    const ext = served.capabilities?.extensions?.find((e) => e.uri === PISTIVA_TRUST_EXTENSION);
    expect(ext, "pistiva-trust extension is not declared");
    expect(ext.required === true, "pistiva-trust extension is not marked required");
    const card = ext.params?.card;
    const signature = ext.params?.signature;
    expect(card && typeof signature === "string", "extension params lack the signed card");
    expect(verifyBytes(provider.publicKey, canonicalBytes(card), signature), "card signature does not verify with the agent's registered key");
    expect(Buffer.compare(canonicalBytes(card), canonicalBytes(provider.card)) === 0, "served card differs from the card registered on the platform");
  });

  // --- Trust: every message must be signed, fresh, granted and used once -------------------------
  const g0 = await grant();
  await check("trust.requires-extension", "Rejects a message without pistiva-trust", async () => {
    const reply = await rpc("message/send", { message: { kind: "message", messageId: randomUUID(), role: "user", parts: [dataPart(sample, "request")] } });
    return expectError(reply, [RpcErrors.unauthorized], "An unsigned message");
  });

  await check("trust.bad-signature", "Rejects a message whose content was changed after signing", async () => {
    const { message } = signed(g0, sample);
    message.parts = [dataPart({ ...sample, tampered: true }, "request")];
    return expectError(await rpc("message/send", { message }), [RpcErrors.unauthorized], "A tampered message");
  });

  await check("trust.expired", "Rejects an expired message", async () => {
    const { message } = signed(g0, sample, { ttlSeconds: -120 });
    return expectError(await rpc("message/send", { message }), [RpcErrors.unauthorized], "An expired message");
  });

  await check("trust.grant-scope", "Rejects a message outside its grant's capability", async () => {
    const { message } = signed(g0, sample, { capability: "pistiva.certify.out-of-scope" });
    return expectError(await rpc("message/send", { message }), [RpcErrors.unauthorized, RpcErrors.forbidden], "An out-of-scope message");
  });

  const g1 = await grant();
  const first = signed(g1, sample);
  let firstReply: RpcReply | undefined;
  await check("trust.replay", "Answers a signed message once and rejects its replay", async () => {
    firstReply = await rpc("message/send", { message: first.message });
    track(firstReply, g1.taskId);
    expect(firstReply.result, `the original message was rejected: ${firstReply.error?.message}`);
    return expectError(await rpc("message/send", { message: first.message }), [RpcErrors.conflict, RpcErrors.unauthorized], "A replayed message");
  });

  await check("trust.task-access", "Shows a task only to its authenticated requester", async () => {
    expectError(await rpc("tasks/get", { id: g1.taskId }), [RpcErrors.unauthorized], "tasks/get without credentials");
    const own = await rpc("tasks/get", { id: g1.taskId }, bearer());
    expect(own.result?.id === g1.taskId, `the requester could not read its task: ${own.error?.message}`);
  });

  // --- Receipts ---------------------------------------------------------------------------------
  await check("receipts.signed", "Signs every reply and its receipt over the exact exchange", async () => {
    const task = firstReply?.result;
    expect(task, "no reply to inspect");
    const envelope = taskEnvelope(task);
    expect(envelope, "reply carries no pistiva-trust envelope");
    verifyEnvelope(envelope, provider.publicKey);
    expect(envelope.header.inReplyTo === first.envelope.header.msgId && envelope.header.to === platform.agentId, "reply is not addressed to the request");
    const signedReceipt = (task.metadata?.[PISTIVA_TRUST] as TaskTrust | undefined)?.receipt;
    const r = signedReceipt?.receipt;
    expect(r && signedReceipt, "reply carries no receipt");
    expect(r.taskId === g1.taskId && r.grantId === g1.jti && r.round === 1 && r.state === task.status.state, "receipt does not describe this round");
    expect(r.requestHash === requestHash(first.envelope), "receipt requestHash does not match the request");
    expect(r.responseHash === responseHash(envelope.body), "receipt responseHash does not match the reply");
    expect(verifyReceiptSignature(r, provider.publicKey, signedReceipt.providerSignature), "receipt signature does not verify");
    return `round 1 ${r.state}`;
  });

  await check("receipts.countersign", "Accepts the requester's countersigned receipt", async () => {
    const signedReceipt = (firstReply?.result?.metadata?.[PISTIVA_TRUST] as TaskTrust | undefined)?.receipt;
    expect(signedReceipt, "no receipt to countersign");
    const both = countersign(signedReceipt, platform.kid, keys);
    await platform.submitReceipt(both).catch(() => undefined);
    const res = await fetch(`${endpoint}${TASKS_PATH}/${g1.taskId}/receipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(both),
      signal: AbortSignal.timeout(timeoutMs),
    });
    expect(res.ok, `countersigned receipt was refused with HTTP ${res.status}`);
  });

  // --- Contract ---------------------------------------------------------------------------------
  await check("contract.rejects-invalid", "Rejects a request that breaks the contract schema", async () => {
    const g = await grant();
    const reply = await rpc("message/send", { message: signed(g, { "pistiva.certify.unexpected": true }).message });
    track(reply, g.taskId);
    return expectError(reply, [RpcErrors.invalidParams], "A schema-violating request");
  });

  let outcome: Awaited<ReturnType<A2AClient["run"]>> | undefined;
  await check("contract.result", "Completes the sample task with a result that matches the contract", async () => {
    const client = new A2AClient({ platform, keys, contracts, timeoutMs, maxAttempts: 1 });
    outcome = await client.run(provider, capability, sample, spend, (c) => ({ answer: c.options?.[0] ?? "yes" }));
    expect(outcome.state === "completed", `task ended ${outcome.state}${outcome.reason ? `: ${outcome.reason}` : ""}`);
    return `${outcome.rounds.length} round(s), fields ${Object.keys(outcome.result ?? {}).join(", ")}`;
  });

  // --- Disclosure -------------------------------------------------------------------------------
  await check("disclosure.grant-fields", "Discloses only fields the grant and the contract allow", async () => {
    expect(outcome?.result, "no completed result to inspect");
    const lastGrant = outcome.grants[outcome.grants.length - 1]!;
    const claims = JSON.parse(fromB64url(lastGrant.grant.split(".")[1] ?? "").toString("utf8")) as { fld?: string[] };
    const allowed = new Set(claims.fld?.length ? claims.fld : await contracts.resultFields(capability, version));
    const extra = Object.keys(outcome.result).filter((f) => !allowed.has(f));
    expect(extra.length === 0, `disclosed fields outside the grant: ${extra.join(", ")}`);
    return `${Object.keys(outcome.result).length} of ${allowed.size} allowed fields`;
  });

  // --- Idempotency ------------------------------------------------------------------------------
  await check("idempotency.retry", "Executes a retried round once and refuses a reused key with a different body", async () => {
    const g = await grant();
    const key = randomUUID();
    const a = await rpc("message/send", { message: signed(g, sample, { idempotencyKey: key }).message });
    track(a, g.taskId);
    expect(a.result, `the first attempt was rejected: ${a.error?.message}`);
    const b = await rpc("message/send", { message: signed(g, sample, { idempotencyKey: key }).message });
    expect(b.result, `the retry was rejected: ${b.error?.message}`);
    expect(b.result.status.state === a.result.status.state, "the retry got a different state");
    expect(JSON.stringify(b.result.status.message?.parts) === JSON.stringify(a.result.status.message?.parts), "the retry got a different reply");
    const c = await rpc("message/send", { message: signed(g, { ...sample, "pistiva.certify.variant": randomUUID() }, { idempotencyKey: key }).message });
    return expectError(c, [RpcErrors.conflict], "A reused idempotency key with a different body");
  });

  // Leave nothing waiting at the partner.
  for (const id of openTasks) await rpc("tasks/cancel", { id }, bearer()).catch(() => undefined);

  return {
    suiteVersion: SUITE_VERSION,
    agentId: provider.agentId,
    orgId: provider.orgId,
    capability,
    taskTypeVersion: version,
    endpoint,
    certifierAgentId: platform.agentId,
    startedAt,
    finishedAt: new Date().toISOString(),
    passed: checks.every((c) => c.passed),
    checks,
  };
}
