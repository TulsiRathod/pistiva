import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  A2A_PATH,
  A2AClient,
  AGENT_ASSERTION_TYP,
  AGENT_CARD_PATH,
  buildEnvelope,
  ContractViolation,
  dataPart,
  PISTIVA_TRUST,
  PISTIVA_TRUST_EXTENSION,
  RpcErrors,
  signJws,
  verifyBytes,
  canonicalBytes,
  verifyReceiptSignature,
  type A2AAgentCard,
  type A2AMessage,
  type A2ATask,
  type AgentCard,
  type DiscoveredAgent,
  type IssuedGrant,
} from "@pistiva/agent-sdk";
import type { FastifyInstance } from "fastify";
import { createProviderGateway, type CapabilityHandler } from "../src/index.ts";
import { FakePlatform, type FakeAgent } from "./fake-platform.ts";

const QUOTE = { sku: "BOLT-M8-50", available: true, qty: 10, uom: "EA", unitPrice: "4.20", currency: "INR", validUntil: "2026-11-01", terms: "Net 30" };

describe("A2A gateway", () => {
  let platform: FakePlatform;
  let buyer: FakeAgent;
  let supplier: FakeAgent;
  let app: FastifyInstance;
  let endpoint: string;
  let calls: { start: number; resume: number };
  let handler: CapabilityHandler;

  async function start(h: CapabilityHandler) {
    handler = h;
    const card: AgentCard = {
      agentId: supplier.agentId,
      orgId: supplier.orgId,
      kid: supplier.kid,
      name: "Test supplier",
      version: "1.0.0",
      endpoint: "http://placeholder",
      protocols: ["a2a/0.3"],
      capabilities: [{ name: "quote.request", version: 1, description: "Quotes" }],
      issuedAt: 1,
    };
    app = createProviderGateway({ agentId: supplier.agentId, kid: supplier.kid, keys: supplier.keys, platform, card, capabilities: { "quote.request": handler } });
    await app.listen({ port: 0, host: "127.0.0.1" });
    endpoint = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    card.endpoint = endpoint;
  }

  beforeEach(() => {
    platform = new FakePlatform();
    buyer = platform.registerAgent();
    supplier = platform.registerAgent();
    calls = { start: 0, resume: 0 };
  });

  afterEach(() => app?.close());

  const discovered = (): DiscoveredAgent =>
    ({
      agentId: supplier.agentId,
      orgId: supplier.orgId,
      orgName: "Test supplier",
      kid: supplier.kid,
      publicKey: supplier.keys.publicKey,
      card: { endpoint, capabilities: [{ name: "quote.request", version: 1 }] },
    }) as unknown as DiscoveredAgent;

  const client = (fields: string[] = []) => new A2AClient({ platform: platform.clientFor(buyer, supplier, fields), keys: buyer.keys });

  function signedMessage(grant: IssuedGrant, data: Record<string, unknown>, o: { kind?: "request" | "answer"; round?: number; idempotencyKey?: string; agent?: FakeAgent } = {}): A2AMessage {
    const agent = o.agent ?? buyer;
    const kind = o.kind ?? "request";
    const parts = [dataPart(data, kind)];
    const env = buildEnvelope(
      { from: agent.agentId, to: supplier.agentId, kid: agent.kid, taskId: grant.taskId, capability: "quote.request", idempotencyKey: o.idempotencyKey ?? randomUUID(), body: parts, grant: grant.grant, kind, round: o.round ?? 1 },
      agent.keys,
    );
    return {
      kind: "message",
      messageId: env.header.msgId,
      role: "user",
      parts,
      ...(kind === "answer" ? { taskId: grant.taskId } : {}),
      metadata: { [PISTIVA_TRUST]: { header: env.header, signature: env.signature } },
    };
  }

  async function rpc(method: string, params: unknown, bearer?: string) {
    const res = await fetch(endpoint + A2A_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await res.json()) as { result?: A2ATask; error?: { code: number; message: string } };
  }

  function bearer(agent: FakeAgent) {
    const now = Math.floor(Date.now() / 1000);
    return signJws(AGENT_ASSERTION_TYP, agent.kid, { iss: agent.agentId, aud: supplier.agentId, iat: now, exp: now + 60, jti: randomUUID() }, agent.keys);
  }

  const singleShot: CapabilityHandler = {
    handle: () => {
      calls.start++;
      return { ...QUOTE, costPrice: "2.65", warehouse: "Pune-2" };
    },
  };

  const multiTurn: CapabilityHandler = {
    start: (_req, ctx) => {
      calls.start++;
      ctx.memory.asked = true;
      return { state: "input-required", clarification: { question: "Partial or backorder?", options: ["partial", "backorder"] } };
    },
    resume: ({ answer }, ctx) => {
      calls.resume++;
      expect(ctx.memory.asked).toBe(true);
      return { state: "completed", result: { ...QUOTE, terms: `answer was ${answer}` } };
    },
  };

  it("serves an A2A agent card with the signed pistiva-trust card", async () => {
    await start(singleShot);
    const card = (await (await fetch(endpoint + AGENT_CARD_PATH)).json()) as A2AAgentCard;
    expect(card.url).toBe(endpoint + A2A_PATH);
    expect(card.preferredTransport).toBe("JSONRPC");
    expect(card.skills.map((s) => s.id)).toEqual(["quote.request@1"]);
    const ext = card.capabilities.extensions.find((e) => e.uri === PISTIVA_TRUST_EXTENSION)!;
    expect(ext.required).toBe(true);
    expect(verifyBytes(supplier.keys.publicKey, canonicalBytes(ext.params!.card), ext.params!.signature as string)).toBe(true);
  });

  it("completes a single-round task with only contract and grant fields disclosed", async () => {
    await start(singleShot);
    const out = await client(["sku", "available", "unitPrice", "currency"]).run(discovered(), "quote.request", { sku: "BOLT-M8-50", qty: 10 }, { budget: "100.00", currency: "INR" });
    expect(out.state).toBe("completed");
    expect(out.result).toEqual({ sku: "BOLT-M8-50", available: true, unitPrice: "4.20", currency: "INR" });
    expect(out.rounds.map((r) => [r.round, r.state, r.recorded])).toEqual([[1, "completed", true]]);
    expect(verifyReceiptSignature(out.rounds[0]!.receipt.receipt, buyer.keys.publicKey, out.rounds[0]!.receipt.requesterSignature)).toBe(true);
  });

  it("runs a clarification round and receipts every round", async () => {
    await start(multiTurn);
    const asked: string[] = [];
    const out = await client().run(discovered(), "quote.request", { sku: "BOLT-M8-50", qty: 500 }, { budget: "100.00", currency: "INR" }, (c) => {
      asked.push(c.question);
      return { answer: "backorder" };
    });
    expect(asked).toEqual(["Partial or backorder?"]);
    expect(out.state).toBe("completed");
    expect(out.result?.terms).toBe("answer was backorder");
    expect(out.rounds.map((r) => [r.round, r.state])).toEqual([[1, "input-required"], [2, "completed"]]);
    expect(platform.receipts).toHaveLength(2);
    expect(calls).toEqual({ start: 1, resume: 1 });
  });

  it("cancels when the requester declines to answer, and only the requester can read the task", async () => {
    await start(multiTurn);
    const out = await client().run(discovered(), "quote.request", { sku: "X", qty: 1 }, { budget: "1.00", currency: "INR" }, () => null);
    expect(out.state).toBe("canceled");

    expect((await rpc("tasks/get", { id: out.taskId }, bearer(buyer))).result?.status.state).toBe("canceled");
    const stranger = platform.registerAgent();
    expect((await rpc("tasks/get", { id: out.taskId }, bearer(stranger))).error?.code).toBe(RpcErrors.taskNotFound);
    expect((await rpc("tasks/get", { id: out.taskId })).error?.code).toBe(RpcErrors.unauthorized);
    expect((await rpc("tasks/cancel", { id: out.taskId }, bearer(buyer))).error?.code).toBe(RpcErrors.taskNotCancelable);
  });

  it("rejects messages without the pistiva-trust extension", async () => {
    await start(singleShot);
    const res = await rpc("message/send", { message: { kind: "message", messageId: "m1", role: "user", parts: [dataPart({ sku: "X", qty: 1 }, "request")] } });
    expect(res.error?.code).toBe(RpcErrors.unauthorized);
  });

  it("rejects a request that violates the contract schema before the handler runs", async () => {
    await start(singleShot);
    const grant = platform.issueGrant({ requester: buyer, provider: supplier, capability: "quote.request" });
    const res = await rpc("message/send", { message: signedMessage(grant, { sku: "BOLT M8 / bad", qty: 0, extra: true }) });
    expect(res.error?.code).toBe(RpcErrors.invalidParams);
    expect(calls.start).toBe(0);
    // The client refuses to send an invalid request at all.
    await expect(client().run(discovered(), "quote.request", { sku: "X" }, { budget: "1.00", currency: "INR" })).rejects.toBeInstanceOf(ContractViolation);
  });

  it("fails the task instead of sending a result that breaks the contract", async () => {
    await start({ handle: () => ({ sku: "X", available: true, unitPrice: 4.2 }) });
    const out = await client().run(discovered(), "quote.request", { sku: "X", qty: 1 }, { budget: "1.00", currency: "INR" });
    expect(out.state).toBe("failed");
    expect(out.reason).toContain("does not match the contract");
  });

  it("serves a retried round from cache and refuses an answer to a task that is not waiting", async () => {
    await start(singleShot);
    const grant = platform.issueGrant({ requester: buyer, provider: supplier, capability: "quote.request" });
    const first = await rpc("message/send", { message: signedMessage(grant, { sku: "X", qty: 1 }, { idempotencyKey: "k1" }) });
    const retry = await rpc("message/send", { message: signedMessage(grant, { sku: "X", qty: 1 }, { idempotencyKey: "k1" }) });
    expect(retry.result).toEqual(first.result);
    expect(calls.start).toBe(1);

    const answer = await rpc("message/send", { message: signedMessage(grant, { answer: "partial" }, { kind: "answer", round: 2 }) });
    expect(answer.error?.code).toBe(RpcErrors.conflict);
  });

  it("rejects a grant pinned to a contract version this agent does not implement", async () => {
    await start(singleShot);
    const grant = platform.issueGrant({ requester: buyer, provider: supplier, capability: "quote.request", taskTypeVersion: 2 });
    const res = await rpc("message/send", { message: signedMessage(grant, { sku: "X", qty: 1 }) });
    expect(res.error?.code).toBe(RpcErrors.forbidden);
  });

  it("returns the result as an artifact with a provider-signed receipt", async () => {
    await start(singleShot);
    const grant = platform.issueGrant({ requester: buyer, provider: supplier, capability: "quote.request" });
    const task = (await rpc("message/send", { message: signedMessage(grant, { sku: "X", qty: 1 }) })).result!;
    const receipt = (task.metadata![PISTIVA_TRUST] as { receipt: { receipt: never; providerSignature: string } }).receipt;
    expect(verifyReceiptSignature(receipt.receipt, supplier.keys.publicKey, receipt.providerSignature)).toBe(true);
    expect(task.artifacts?.[0]?.parts[0]).toMatchObject({ kind: "data" });
  });
});
