import {
  buildEnvelope,
  ContractRegistry,
  requestHash,
  responseHash,
  signReceipt,
  TASKS_PATH,
  VerificationError,
  verifyEnvelope,
  verifyGrant,
  verifyReceiptSignature,
  type AgentCard,
  type AgentKeyPair,
  type Envelope,
  type GrantClaims,
  type PlatformLookup,
  type Receipt,
  type SignedReceipt,
  type TaskResponse,
  type A2ATask,
} from "@pistiva/agent-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { registerA2ARoutes } from "./a2a-server.ts";
import { LocalAuditLog, type AuditSink } from "./audit-log.ts";
import { IdempotencyStore, MemoryRoundStore, MemoryTaskStore, NonceCache, type NonceStore, type RoundStore, type TaskStore } from "./stores.ts";

export interface TaskContext {
  taskId: string;
  requesterAgentId: string;
  requesterOrgId: string;
  grant: GrantClaims;
  /** 1 for the opening request, then +1 for every answer to a clarification. */
  round: number;
  /** Per-task scratch space a handler can use to carry state between rounds. Never sent to the requester. */
  memory: Record<string, unknown>;
}

export type HandlerOutcome<R extends Record<string, unknown> = Record<string, unknown>> =
  | { state: "completed"; result: R }
  | { state: "input-required"; clarification: Record<string, unknown> }
  | { state: "rejected"; reason: string }
  | { state: "failed"; reason: string };

export interface CapabilityHandler<B = any, R extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Local disclosure allowlist. Defaults to the contract's result fields. Whatever the handler
   * returns beyond this (and beyond the grant's field list) is stripped before signing.
   */
  responseFields?: string[];
  /** Extra local checks on input beyond the contract schema. Return an error message or null. */
  validate?(body: unknown): string | null;
  /** Single-shot handler: always completes in one round. */
  handle?(body: B, ctx: TaskContext): Promise<R> | R;
  /** Multi-turn handler: may ask a clarifying question instead of completing. */
  start?(request: B, ctx: TaskContext): Promise<HandlerOutcome<R>> | HandlerOutcome<R>;
  /** Continues a task after the requester answers a clarification. */
  resume?(answer: Record<string, unknown>, ctx: TaskContext): Promise<HandlerOutcome<R>> | HandlerOutcome<R>;
}

export interface ProviderGatewayOptions {
  agentId: string;
  kid: string;
  keys: AgentKeyPair;
  platform: PlatformLookup;
  capabilities: Record<string, CapabilityHandler>;
  /** This agent's card; when present the gateway serves an A2A agent card built from it. */
  card?: AgentCard;
  description?: string;
  contracts?: ContractRegistry;
  /** Where A2A task state lives; in memory unless the host app provides a database-backed store. */
  taskStore?: TaskStore;
  /** Where replies to retried rounds live; in memory unless the host app shares one across replicas. */
  roundStore?: RoundStore;
  /** Where seen nonces live; in memory unless the host app shares one across replicas. */
  nonceStore?: NonceStore;
  /** Custom sink for the gateway's own log; defaults to a JSONL file at auditLogPath. */
  audit?: AuditSink;
  auditLogPath?: string;
  /** Called after every A2A round with the full local view of it (request data, reply and receipt). */
  onRound?(round: RoundRecord): Promise<void> | void;
  /** Called when the requester returns a valid countersigned receipt. */
  onCountersigned?(receipt: SignedReceipt): Promise<void> | void;
  logger?: boolean;
}

/** The provider's own record of one round. It stays inside the provider's infrastructure. */
export interface RoundRecord {
  taskId: string;
  round: number;
  requesterAgentId: string;
  requesterOrgId: string;
  capability: string;
  taskTypeVersion: number;
  kind: "request" | "answer";
  request: Record<string, unknown>;
  state: A2ATask["status"]["state"];
  reply: A2ATask["status"]["message"];
  receipt: SignedReceipt;
  fieldsWithheld: string[];
}

export class TaskRejection extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** State and checks shared by the legacy route and the A2A server. */
export interface GatewayCore {
  opts: ProviderGatewayOptions;
  contracts: ContractRegistry;
  nonces: NonceStore;
  rounds: RoundStore;
  tasks: TaskStore;
  audit: AuditSink;
  authorize(envelope: Envelope): Promise<{ grant: GrantClaims; requesterOrgId: string }>;
  /** Local allowlist ∩ grant field list: the fields that may leave this organization. */
  disclosable(capability: string, grant: GrantClaims): Promise<string[]>;
}

const STATUS_FOR_CODE: Record<string, number> = {
  malformed: 400,
  bad_signature: 401,
  unknown_key: 401,
  expired: 401,
  untrusted_requester: 401,
  grant_mismatch: 403,
  out_of_scope: 403,
  replay: 409,
};

/**
 * The provider half of the two-layer policy check. Runs on the provider's own infrastructure,
 * next to its private systems, and decides deterministically whether to answer and what to disclose.
 */
export function createProviderGateway(opts: ProviderGatewayOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const idempotency = new IdempotencyStore();
  const core: GatewayCore = {
    opts,
    contracts: opts.contracts ?? new ContractRegistry(opts.platform),
    nonces: opts.nonceStore ?? new NonceCache(),
    rounds: opts.roundStore ?? new MemoryRoundStore(),
    tasks: opts.taskStore ?? new MemoryTaskStore(),
    audit: opts.audit ?? new LocalAuditLog(opts.auditLogPath),
    authorize,
    disclosable,
  };

  app.get("/pistiva/v1/health", async () => ({ ok: true, agentId: opts.agentId }));
  registerA2ARoutes(app, core);

  /** Milestone-1 single-round route, kept while requesters migrate to A2A. */
  app.post(TASKS_PATH, async (req, reply) => {
    const envelope = req.body as Envelope;
    try {
      const { grant } = await authorize(envelope);
      const bodyHash = responseHash(envelope.body);
      const key = `${envelope.header.from}:${envelope.header.taskId}:${envelope.header.idempotencyKey}`;
      const existing = idempotency.get(key);
      if (existing) {
        if (existing.bodyHash !== bodyHash) {
          throw new TaskRejection(409, "idempotency_conflict", "Idempotency key reused with a different request body");
        }
        await core.audit.write("task.retry_served_from_cache", { taskId: envelope.header.taskId, from: envelope.header.from });
        return await existing.response;
      }
      const response = execute(envelope, grant);
      idempotency.put(key, bodyHash, response);
      return await response;
    } catch (e) {
      const { status, code, message } = toRejection(e);
      await core.audit.write("task.rejected", { taskId: envelope?.header?.taskId, from: envelope?.header?.from, code, message });
      return reply.code(status).send({ error: code, message });
    }
  });

  /** The requester returns the countersigned receipt so both sides hold the same evidence. */
  app.post(`${TASKS_PATH}/:taskId/receipt`, async (req, reply) => {
    const signed = req.body as SignedReceipt;
    const r = signed?.receipt;
    if (!r || r.taskId !== (req.params as { taskId: string }).taskId || r.providerAgentId !== opts.agentId) {
      return reply.code(400).send({ error: "malformed", message: "Receipt does not belong to this provider" });
    }
    const status = await opts.platform.agentStatus(r.requesterAgentId);
    const key = status.keys.find((k) => k.kid === signed.requesterKid && !k.revoked);
    const ok =
      !!key &&
      verifyReceiptSignature(r, key.publicKey, signed.requesterSignature) &&
      verifyReceiptSignature(r, opts.keys.publicKey, signed.providerSignature);
    await core.audit.write(ok ? "receipt.countersigned" : "receipt.invalid_countersignature", { taskId: r.taskId, round: r.round, receipt: signed });
    if (ok) await opts.onCountersigned?.(signed);
    return ok ? { ok: true } : reply.code(400).send({ error: "bad_signature", message: "Countersignature does not verify" });
  });

  async function authorize(envelope: Envelope): Promise<{ grant: GrantClaims; requesterOrgId: string }> {
    const h = envelope?.header;
    if (!h || typeof h.from !== "string" || typeof h.kid !== "string" || typeof h.grant !== "string") {
      throw new VerificationError("Malformed envelope", "malformed");
    }
    if (h.to !== opts.agentId) throw new VerificationError("Envelope is addressed to another agent", "grant_mismatch");

    // Requester identity: live key of an active agent in a verified organization.
    const status = await opts.platform.agentStatus(h.from);
    const senderKey = status.keys.find((k) => k.kid === h.kid && !k.revoked);
    if (!senderKey) throw new VerificationError("Requester key is unknown or revoked", "unknown_key");
    if (status.status !== "ACTIVE" || !status.orgTrusted) {
      throw new VerificationError("Requester is suspended or its organization is not trusted", "untrusted_requester");
    }
    verifyEnvelope(envelope, senderKey.publicKey);

    const grant = verifyGrant(h.grant, await opts.platform.jwks(), { issuer: opts.platform.issuer, header: h });
    if (grant.rorg !== status.orgId) throw new VerificationError("Grant organization does not match requester", "grant_mismatch");
    if (!opts.capabilities[h.capability]) {
      throw new VerificationError(`Capability ${h.capability} is not offered here`, "out_of_scope");
    }
    const offered = opts.card?.capabilities.find((c) => c.name === h.capability);
    if (offered && grant.ttv !== undefined && offered.version !== grant.ttv) {
      throw new VerificationError(`Grant pins ${h.capability}@${grant.ttv} but this agent implements @${offered.version}`, "out_of_scope");
    }
    if (!(await core.nonces.firstUse(`${h.from}:${h.nonce}`, h.exp))) {
      throw new VerificationError("Envelope replayed", "replay");
    }
    return { grant, requesterOrgId: status.orgId };
  }

  async function disclosable(capability: string, grant: GrantClaims): Promise<string[]> {
    const local = opts.capabilities[capability]?.responseFields ?? (await core.contracts.resultFields(capability, grant.ttv ?? 1));
    return local.filter((f) => grant.fld.length === 0 || grant.fld.includes(f));
  }

  async function execute(envelope: Envelope, grant: GrantClaims): Promise<TaskResponse> {
    const h = envelope.header;
    const capability = opts.capabilities[h.capability]!;
    const invalid = capability.validate?.(envelope.body);
    if (invalid) throw new TaskRejection(400, "invalid_request", invalid);

    const ctx: TaskContext = { taskId: h.taskId, requesterAgentId: h.from, requesterOrgId: grant.rorg, grant, round: 1, memory: {} };
    let raw: Record<string, unknown>;
    if (capability.handle) {
      raw = await capability.handle(envelope.body, ctx);
    } else {
      const outcome = await capability.start!(envelope.body, ctx);
      if (outcome.state !== "completed") {
        throw new TaskRejection(409, "requires_a2a", "This task needs more than one round; use the A2A endpoint");
      }
      raw = outcome.result;
    }
    const allowed = await disclosable(h.capability, grant);
    const body: Record<string, unknown> = {};
    for (const field of allowed) if (field in raw) body[field] = raw[field];
    const withheld = Object.keys(raw).filter((f) => !(f in body));

    const response = buildEnvelope(
      { from: opts.agentId, to: h.from, kid: opts.kid, taskId: h.taskId, capability: h.capability, idempotencyKey: h.idempotencyKey, inReplyTo: h.msgId, body },
      opts.keys,
    );
    const receipt: Receipt = {
      taskId: h.taskId,
      grantId: grant.jti,
      round: 1,
      state: "completed",
      requesterAgentId: h.from,
      providerAgentId: opts.agentId,
      capability: h.capability,
      taskTypeVersion: grant.ttv ?? 1,
      requestHash: requestHash(envelope),
      responseHash: responseHash(body),
      issuedAt: Math.floor(Date.now() / 1000),
    };
    await core.audit.write("task.completed", {
      taskId: h.taskId,
      from: h.from,
      capability: h.capability,
      requestHash: receipt.requestHash,
      responseHash: receipt.responseHash,
      fieldsReturned: Object.keys(body),
      fieldsWithheld: withheld,
    });
    return { envelope: response, receipt: { receipt, providerKid: opts.kid, providerSignature: signReceipt(receipt, opts.keys) } };
  }

  return app;
}

export function toRejection(e: unknown): { status: number; code: string; message: string } {
  if (e instanceof TaskRejection) return { status: e.status, code: e.code, message: e.message };
  if (e instanceof VerificationError) return { status: STATUS_FOR_CODE[e.code] ?? 401, code: e.code, message: e.message };
  return { status: 500, code: "provider_error", message: e instanceof Error ? e.message : "Internal error" };
}
