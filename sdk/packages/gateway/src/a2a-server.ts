import {
  A2A_PATH,
  A2A_PROTOCOL_VERSION,
  AGENT_ASSERTION_TYP,
  AGENT_CARD_PATH,
  buildEnvelope,
  ContractViolation,
  dataPart,
  fromB64url,
  PISTIVA_TRUST,
  PISTIVA_TRUST_EXTENSION,
  messageEnvelope,
  requestHash,
  responseHash,
  RpcErrors,
  signCard,
  signReceipt,
  singleDataPart,
  TERMINAL_STATES,
  VerificationError,
  verifyJws,
  type A2AAgentCard,
  type A2AMessage,
  type A2ATask,
  type JsonRpcError,
  type JsonRpcRequest,
  type MessageKind,
  type Part,
  type Receipt,
  type RoundResponseBody,
  type TaskTrust,
} from "@pistiva/agent-sdk";
import type { FastifyInstance } from "fastify";
import { TaskRejection, type GatewayCore, type HandlerOutcome, type TaskContext } from "./gateway.ts";
import type { StoredTask } from "./stores.ts";

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

function toRpcError(e: unknown): JsonRpcError {
  if (e instanceof RpcFailure) return { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) };
  if (e instanceof ContractViolation) return { code: RpcErrors.invalidParams, message: e.message, data: { kind: e.kind, errors: e.errors } };
  if (e instanceof VerificationError) {
    const code =
      e.code === "replay" ? RpcErrors.conflict
      : e.code === "grant_mismatch" || e.code === "out_of_scope" ? RpcErrors.forbidden
      : e.code === "malformed" ? RpcErrors.invalidParams
      : RpcErrors.unauthorized;
    return { code, message: e.message, data: { reason: e.code } };
  }
  if (e instanceof TaskRejection) {
    const code = e.status === 409 ? RpcErrors.conflict : e.status === 400 ? RpcErrors.invalidParams : RpcErrors.internal;
    return { code, message: e.message, data: { reason: e.code } };
  }
  return { code: RpcErrors.internal, message: "Internal error" };
}

/**
 * A2A JSON-RPC binding of the provider gateway. Every message must carry the pistiva-trust extension:
 * the requester's signature over the message parts and a platform grant. Each reply is signed by
 * this provider and carries a receipt for its round.
 */
export function registerA2ARoutes(app: FastifyInstance, core: GatewayCore): void {
  const { opts } = core;
  const tasks = core.tasks;
  // Per round: (requester, task, idempotency key) -> the signed reply, so a retried round is answered once.
  const rounds = new Map<string, { bodyHash: string; reply: Promise<A2ATask> }>();

  app.get(AGENT_CARD_PATH, async (_req, reply) => {
    if (!opts.card) return reply.code(404).send({ error: "not_found", message: "No agent card configured" });
    return agentCard();
  });

  app.post(A2A_PATH, async (req) => {
    const rpc = req.body as JsonRpcRequest<Record<string, unknown>>;
    const id = rpc && typeof rpc === "object" && "id" in rpc ? rpc.id : null;
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
      return { jsonrpc: "2.0", id, error: { code: RpcErrors.invalidRequest, message: "Not a JSON-RPC 2.0 request" } };
    }
    try {
      const auth = req.headers.authorization;
      switch (rpc.method) {
        case "message/send":
          return { jsonrpc: "2.0", id, result: await sendMessage(rpc.params?.message as A2AMessage) };
        case "tasks/get":
          return { jsonrpc: "2.0", id, result: (await ownedTask(auth, rpc.params?.id)).task! };
        case "tasks/cancel":
          return { jsonrpc: "2.0", id, result: await cancel(auth, rpc.params?.id) };
        case "message/stream":
        case "tasks/resubscribe":
          throw new RpcFailure(RpcErrors.unsupportedOperation, `${rpc.method} is not supported yet`);
        default:
          throw new RpcFailure(RpcErrors.methodNotFound, `Unknown method ${rpc.method}`);
      }
    } catch (e) {
      const error = toRpcError(e);
      await core.audit.write("a2a.rejected", { method: rpc.method, code: error.code, message: error.message });
      return { jsonrpc: "2.0", id, error };
    }
  });

  async function sendMessage(message: A2AMessage): Promise<A2ATask> {
    if (!message || message.kind !== "message" || !Array.isArray(message.parts)) {
      throw new RpcFailure(RpcErrors.invalidParams, "params.message must be an A2A message");
    }
    const envelope = messageEnvelope(message);
    if (!envelope) throw new RpcFailure(RpcErrors.unauthorized, `Messages must carry the ${PISTIVA_TRUST_EXTENSION} extension`);
    const { grant, requesterOrgId } = await core.authorize(envelope);
    const h = envelope.header;

    const key = `${h.from}:${h.taskId}:${h.idempotencyKey}`;
    const bodyHash = responseHash(envelope.body);
    const cached = rounds.get(key);
    if (cached) {
      if (cached.bodyHash !== bodyHash) throw new TaskRejection(409, "idempotency_conflict", "Idempotency key reused with a different message");
      await core.audit.write("a2a.retry_served_from_cache", { taskId: h.taskId, round: h.round });
      return cached.reply;
    }
    const reply = runRound(message, envelope, grant, requesterOrgId);
    rounds.set(key, { bodyHash, reply });
    reply.catch(() => rounds.delete(key));
    return reply;
  }

  async function runRound(
    message: A2AMessage,
    envelope: NonNullable<ReturnType<typeof messageEnvelope>>,
    grant: Awaited<ReturnType<GatewayCore["authorize"]>>["grant"],
    requesterOrgId: string,
  ): Promise<A2ATask> {
    const h = envelope.header;
    const ttv = grant.ttv ?? 1;
    const existing = await tasks.get(h.taskId);
    let stored: StoredTask;
    let expectedKind: MessageKind;
    if (!existing) {
      if (message.taskId && message.taskId !== h.taskId) throw new RpcFailure(RpcErrors.taskNotFound, "Unknown task");
      stored = { id: h.taskId, requesterAgentId: h.from, requesterOrgId, capability: h.capability, taskTypeVersion: ttv, round: 0, state: "submitted", memory: {} };
      expectedKind = "request";
    } else {
      if (existing.requesterAgentId !== h.from || message.taskId !== h.taskId) throw new RpcFailure(RpcErrors.taskNotFound, "Unknown task");
      if (existing.state !== "input-required") {
        throw new RpcFailure(RpcErrors.conflict, `Task is ${existing.state}; only an input-required task accepts an answer`);
      }
      stored = existing;
      expectedKind = "answer";
    }
    const round = stored.round + 1;
    if (h.kind !== expectedKind || h.round !== round) {
      throw new RpcFailure(RpcErrors.invalidParams, `Expected a ${expectedKind} message for round ${round}`);
    }
    if (h.capability !== stored.capability) throw new VerificationError("Message capability does not match the task", "grant_mismatch");

    const data = singleDataPart(message.parts);
    if (!data) throw new RpcFailure(RpcErrors.invalidParams, "A contract message carries exactly one data part");
    await core.contracts.validate(h.capability, ttv, expectedKind, data);
    const handler = opts.capabilities[h.capability]!;
    const localError = expectedKind === "request" ? handler.validate?.(data) : null;
    if (localError) throw new RpcFailure(RpcErrors.invalidParams, localError);

    const ctx: TaskContext = { taskId: h.taskId, requesterAgentId: h.from, requesterOrgId, grant, round, memory: stored.memory };
    let outcome: HandlerOutcome;
    try {
      outcome =
        expectedKind === "request"
          ? handler.start ? await handler.start(data, ctx) : { state: "completed", result: await handler.handle!(data, ctx) }
          : handler.resume ? await handler.resume(data, ctx) : { state: "failed", reason: "This agent does not support clarification answers" };
    } catch (e) {
      await core.audit.write("a2a.handler_error", { taskId: h.taskId, round, error: e instanceof Error ? e.message : String(e) });
      outcome = { state: "failed", reason: "The provider could not complete the task" };
    }

    const { state, parts, withheld } = await replyParts(outcome, h.capability, ttv, grant);
    const body: RoundResponseBody = { state, parts };
    const response = buildEnvelope(
      {
        from: opts.agentId,
        to: h.from,
        kid: opts.kid,
        taskId: h.taskId,
        capability: h.capability,
        idempotencyKey: h.idempotencyKey,
        inReplyTo: h.msgId,
        kind: state === "input-required" ? "clarification" : "result",
        round,
        body,
      },
      opts.keys,
    );
    const receipt: Receipt = {
      taskId: h.taskId,
      grantId: grant.jti,
      round,
      state,
      requesterAgentId: h.from,
      providerAgentId: opts.agentId,
      capability: h.capability,
      taskTypeVersion: ttv,
      requestHash: requestHash(envelope),
      responseHash: responseHash(body),
      issuedAt: Math.floor(Date.now() / 1000),
    };
    const trust: TaskTrust = {
      header: response.header,
      signature: response.signature,
      receipt: { receipt, providerKid: opts.kid, providerSignature: signReceipt(receipt, opts.keys) },
    };
    const agentMessage: A2AMessage = { kind: "message", messageId: response.header.msgId, role: "agent", parts, taskId: h.taskId, contextId: h.taskId };
    const task: A2ATask = {
      kind: "task",
      id: h.taskId,
      contextId: h.taskId,
      status: { state, message: agentMessage, timestamp: new Date().toISOString() },
      ...(state === "completed" ? { artifacts: [{ artifactId: `${h.taskId}-result`, name: h.capability, parts }] } : {}),
      metadata: { [PISTIVA_TRUST]: trust },
    };
    Object.assign(stored, { round, state, task });
    await tasks.save(stored);
    await core.audit.write(`a2a.round.${state}`, {
      taskId: h.taskId,
      round,
      from: h.from,
      capability: `${h.capability}@${ttv}`,
      requestHash: receipt.requestHash,
      responseHash: receipt.responseHash,
      fieldsReturned: state === "completed" ? Object.keys((parts[0] as { data?: object }).data ?? {}) : [],
      fieldsWithheld: withheld,
    });
    await opts.onRound?.({
      taskId: h.taskId,
      round,
      requesterAgentId: h.from,
      requesterOrgId,
      capability: h.capability,
      taskTypeVersion: ttv,
      kind: expectedKind as "request" | "answer",
      request: data,
      state,
      reply: agentMessage,
      receipt: trust.receipt,
      fieldsWithheld: withheld,
    });
    return task;
  }

  /** Builds the reply parts for an outcome, enforcing disclosure rules and the contract on our own output. */
  async function replyParts(outcome: HandlerOutcome, capability: string, ttv: number, grant: Parameters<GatewayCore["disclosable"]>[1]) {
    if (outcome.state === "rejected" || outcome.state === "failed") {
      return { state: outcome.state, parts: [{ kind: "text", text: outcome.reason } as Part], withheld: [] as string[] };
    }
    if (outcome.state === "input-required") {
      await core.contracts.validate(capability, ttv, "clarification", outcome.clarification);
      return { state: outcome.state, parts: [dataPart(outcome.clarification, "clarification")], withheld: [] };
    }
    const allowed = await core.disclosable(capability, grant);
    const result: Record<string, unknown> = {};
    for (const field of allowed) if (field in outcome.result) result[field] = outcome.result[field];
    const withheld = Object.keys(outcome.result).filter((f) => !(f in result));
    try {
      await core.contracts.validate(capability, ttv, "result", result);
    } catch (e) {
      // Our own handler broke the contract: fail the task rather than send a malformed result.
      await core.audit.write("a2a.invalid_result", { capability, errors: e instanceof ContractViolation ? e.errors : String(e) });
      return { state: "failed" as const, parts: [{ kind: "text", text: "The provider produced a result that does not match the contract" } as Part], withheld };
    }
    return { state: outcome.state, parts: [dataPart(result, "result")], withheld };
  }

  /**
   * tasks/get and tasks/cancel are authenticated with a pistiva-agent+jwt bearer assertion addressed to
   * this agent. Only the task's requester can see or cancel it; anyone else gets "not found".
   */
  async function ownedTask(authorization: string | undefined, id: unknown): Promise<StoredTask> {
    if (typeof id !== "string") throw new RpcFailure(RpcErrors.invalidParams, "params.id is required");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : undefined;
    if (!token) throw new RpcFailure(RpcErrors.unauthorized, "A pistiva-agent+jwt bearer assertion is required");
    let iss: string;
    try {
      iss = JSON.parse(fromB64url(token.split(".")[1] ?? "").toString("utf8")).iss;
    } catch {
      throw new RpcFailure(RpcErrors.unauthorized, "Malformed assertion");
    }
    const status = await opts.platform.agentStatus(iss);
    const { payload } = verifyJws<{ iss: string; aud: string; jti: string; exp: number }>(token, AGENT_ASSERTION_TYP, (hdr) =>
      status.keys.find((k) => k.kid === hdr.kid && !k.revoked)?.publicKey,
    );
    if (payload.aud !== opts.agentId || status.status !== "ACTIVE" || !status.orgTrusted) {
      throw new RpcFailure(RpcErrors.unauthorized, "Assertion is not valid for this agent");
    }
    if (!payload.jti || !core.nonces.firstUse(`${iss}:assertion:${payload.jti}`, payload.exp)) {
      throw new RpcFailure(RpcErrors.unauthorized, "Assertion replayed");
    }
    const stored = await tasks.get(id);
    if (!stored || stored.requesterAgentId !== iss) throw new RpcFailure(RpcErrors.taskNotFound, "Task not found");
    return stored;
  }

  async function cancel(authorization: string | undefined, id: unknown): Promise<A2ATask> {
    const stored = await ownedTask(authorization, id);
    if (TERMINAL_STATES.includes(stored.state)) throw new RpcFailure(RpcErrors.taskNotCancelable, `Task is already ${stored.state}`);
    stored.state = "canceled";
    // A cancellation is not a signed round: there is no provider answer to vouch for.
    stored.task = { ...stored.task!, status: { state: "canceled", timestamp: new Date().toISOString() }, metadata: {} };
    await tasks.save(stored);
    await core.audit.write("a2a.canceled", { taskId: stored.id, round: stored.round });
    return stored.task;
  }

  function agentCard(): A2AAgentCard {
    const card = opts.card!;
    return {
      protocolVersion: A2A_PROTOCOL_VERSION,
      name: card.name,
      description: opts.description ?? card.name,
      url: card.endpoint.replace(/\/$/, "") + A2A_PATH,
      preferredTransport: "JSONRPC",
      version: card.version,
      capabilities: {
        streaming: false,
        pushNotifications: false,
        extensions: [
          {
            uri: PISTIVA_TRUST_EXTENSION,
            required: true,
            description: "Signed messages, platform-issued task grants and per-round receipts",
            params: { agentId: card.agentId, orgId: card.orgId, kid: card.kid, card, signature: signCard(card, opts.keys) },
          },
        ],
      },
      securitySchemes: { pistivaAgentAssertion: { type: "http", scheme: "bearer", bearerFormat: AGENT_ASSERTION_TYP } },
      security: [{ pistivaAgentAssertion: [] }],
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: card.capabilities.map((c) => ({
        id: `${c.name}@${c.version}`,
        name: c.name,
        description: c.description ?? c.name,
        tags: [c.name.split(".")[0]!, `task-type:${c.name}@${c.version}`],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      })),
    };
  }
}
