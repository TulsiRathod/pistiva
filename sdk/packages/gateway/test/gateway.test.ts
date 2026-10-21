import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildEnvelope,
  requestHash,
  responseHash,
  TASKS_PATH,
  TaskClient,
  verifyEnvelope,
  verifyReceiptSignature,
  type DiscoveredAgent,
  type Envelope,
  type TaskResponse,
} from "@pistiva/agent-sdk";
import type { FastifyInstance } from "fastify";
import { createProviderGateway } from "../src/index.ts";
import { FakePlatform, type FakeAgent } from "./fake-platform.ts";

const QUOTE_FIELDS = ["available", "unitPrice", "validUntil", "terms"];

describe("provider gateway", () => {
  let platform: FakePlatform;
  let buyer: FakeAgent;
  let supplier: FakeAgent;
  let app: FastifyInstance;
  let handlerCalls: number;

  beforeEach(async () => {
    platform = new FakePlatform();
    buyer = platform.registerAgent();
    supplier = platform.registerAgent();
    handlerCalls = 0;
    app = createProviderGateway({
      agentId: supplier.agentId,
      kid: supplier.kid,
      keys: supplier.keys,
      platform,
      capabilities: {
        "quote.request": {
          responseFields: QUOTE_FIELDS,
          validate: (b) => (typeof (b as { sku?: unknown })?.sku === "string" ? null : "sku is required"),
          handle: () => {
            handlerCalls++;
            // The private record has more than the buyer may see.
            return { available: 40, unitPrice: "125.00", validUntil: "2026-11-01", terms: "Net 30", costPrice: "80.00", warehouse: "Pune-2" };
          },
        },
      },
    });
    await app.ready();
  });

  afterEach(() => app.close());

  function request(opts: { capability?: string; grantCapability?: string; idempotencyKey?: string; grant?: string; taskId?: string; body?: unknown } = {}) {
    const capability = opts.capability ?? "quote.request";
    const issued = platform.issueGrant({ requester: buyer, provider: supplier, capability: opts.grantCapability ?? capability, fields: QUOTE_FIELDS });
    return buildEnvelope(
      {
        from: buyer.agentId,
        to: supplier.agentId,
        kid: buyer.kid,
        taskId: opts.taskId ?? issued.taskId,
        capability,
        idempotencyKey: opts.idempotencyKey ?? randomUUID(),
        body: opts.body ?? { sku: "BOLT-M8", qty: 10 },
        grant: opts.grant ?? issued.grant,
      },
      buyer.keys,
    );
  }

  const send = (envelope: Envelope) => app.inject({ method: "POST", url: TASKS_PATH, payload: envelope });

  it("answers a valid request with only allowlisted fields and a verifiable receipt", async () => {
    const env = request();
    const res = await send(env);
    expect(res.statusCode).toBe(200);
    const out = res.json() as TaskResponse<Record<string, unknown>>;

    expect(Object.keys(out.envelope.body).sort()).toEqual([...QUOTE_FIELDS].sort());
    expect(out.envelope.body).not.toHaveProperty("costPrice");
    expect(out.envelope.body).not.toHaveProperty("warehouse");

    verifyEnvelope(out.envelope, supplier.keys.publicKey);
    expect(out.envelope.header.inReplyTo).toBe(env.header.msgId);
    expect(out.receipt.receipt.requestHash).toBe(requestHash(env));
    expect(out.receipt.receipt.responseHash).toBe(responseHash(out.envelope.body));
    expect(verifyReceiptSignature(out.receipt.receipt, supplier.keys.publicKey, out.receipt.providerSignature)).toBe(true);
  });

  it("discloses the intersection of the local allowlist and the grant", async () => {
    const issued = platform.issueGrant({ requester: buyer, provider: supplier, capability: "quote.request", fields: ["available"] });
    const env = buildEnvelope(
      { from: buyer.agentId, to: supplier.agentId, kid: buyer.kid, taskId: issued.taskId, capability: "quote.request", idempotencyKey: "k", body: { sku: "X" }, grant: issued.grant },
      buyer.keys,
    );
    const res = await send(env);
    expect(Object.keys((res.json() as TaskResponse<object>).envelope.body)).toEqual(["available"]);
  });

  it("rejects a tampered body", async () => {
    const env = request();
    const res = await send({ ...env, body: { sku: "BOLT-M8", qty: 10_000 } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("bad_signature");
  });

  it("rejects a replayed envelope", async () => {
    const env = request();
    expect((await send(env)).statusCode).toBe(200);
    const replay = await send(env);
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error).toBe("replay");
  });

  it("serves a retry with the same idempotency key from cache without redoing the work", async () => {
    const issued = platform.issueGrant({ requester: buyer, provider: supplier, capability: "quote.request", fields: QUOTE_FIELDS });
    const attempt = () =>
      buildEnvelope(
        { from: buyer.agentId, to: supplier.agentId, kid: buyer.kid, taskId: issued.taskId, capability: "quote.request", idempotencyKey: "same-key", body: { sku: "BOLT-M8" }, grant: issued.grant },
        buyer.keys,
      );
    const first = await send(attempt());
    const retry = await send(attempt());
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(handlerCalls).toBe(1);
  });

  it("rejects reuse of an idempotency key with a different body", async () => {
    const issued = platform.issueGrant({ requester: buyer, provider: supplier, capability: "quote.request", fields: QUOTE_FIELDS });
    const make = (sku: string) =>
      buildEnvelope(
        { from: buyer.agentId, to: supplier.agentId, kid: buyer.kid, taskId: issued.taskId, capability: "quote.request", idempotencyKey: "same-key", body: { sku }, grant: issued.grant },
        buyer.keys,
      );
    expect((await send(make("A"))).statusCode).toBe(200);
    expect((await send(make("B"))).statusCode).toBe(409);
  });

  it("rejects an expired grant", async () => {
    const issued = platform.issueGrant({ requester: buyer, provider: supplier, capability: "quote.request", expiresIn: -10 });
    const res = await send(request({ grant: issued.grant, taskId: issued.taskId }));
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("expired");
  });

  it("rejects a grant addressed to another provider or issued to another requester", async () => {
    const toOther = platform.issueGrant({ requester: buyer, provider: supplier, capability: "quote.request", audience: randomUUID() });
    expect((await send(request({ grant: toOther.grant, taskId: toOther.taskId }))).statusCode).toBe(403);
    const forOther = platform.issueGrant({ requester: buyer, provider: supplier, capability: "quote.request", subject: randomUUID() });
    expect((await send(request({ grant: forOther.grant, taskId: forOther.taskId }))).statusCode).toBe(403);
  });

  it("rejects a capability the grant does not cover or the provider does not offer", async () => {
    expect((await send(request({ capability: "quote.request", grantCapability: "inventory.export" }))).json().error).toBe("out_of_scope");
    const res = await send(request({ capability: "inventory.export" }));
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("out_of_scope");
  });

  it("rejects a revoked key and a suspended requester", async () => {
    const env = request();
    platform.revokeKey(buyer);
    expect((await send(env)).json().error).toBe("unknown_key");

    const other = platform.registerAgent();
    platform.suspend(other);
    const issued = platform.issueGrant({ requester: other, provider: supplier, capability: "quote.request" });
    const env2 = buildEnvelope(
      { from: other.agentId, to: supplier.agentId, kid: other.kid, taskId: issued.taskId, capability: "quote.request", idempotencyKey: "k", body: { sku: "X" }, grant: issued.grant },
      other.keys,
    );
    expect((await send(env2)).json().error).toBe("untrusted_requester");
  });

  it("validates input before calling the handler", async () => {
    const res = await send(request({ body: { qty: 1 } }));
    expect(res.statusCode).toBe(400);
    expect(handlerCalls).toBe(0);
  });
});

describe("task client against a live gateway", () => {
  let app: FastifyInstance;

  afterEach(() => app?.close());

  it("completes a task, verifies the response and countersigns the receipt on both sides", async () => {
    const platform = new FakePlatform();
    const buyer = platform.registerAgent();
    const supplier = platform.registerAgent();
    app = createProviderGateway({
      agentId: supplier.agentId,
      kid: supplier.kid,
      keys: supplier.keys,
      platform,
      capabilities: { "quote.request": { responseFields: QUOTE_FIELDS, handle: () => ({ available: 5, unitPrice: "9.50", validUntil: "2026-11-01", terms: "Net 30", costPrice: "4.00" }) } },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;

    const discovered = {
      agentId: supplier.agentId,
      orgId: supplier.orgId,
      kid: supplier.kid,
      publicKey: supplier.keys.publicKey,
      card: { endpoint: `http://127.0.0.1:${port}` },
    } as DiscoveredAgent;

    const client = new TaskClient({ platform: platform.clientFor(buyer, supplier, QUOTE_FIELDS), keys: buyer.keys });
    const outcome = await client.request<{ sku: string }, Record<string, unknown>>(discovered, "quote.request", { sku: "X" }, { budget: "100.00", currency: "INR" });

    expect(outcome.result).toEqual({ available: 5, unitPrice: "9.50", validUntil: "2026-11-01", terms: "Net 30" });
    expect(outcome.recorded).toBe(true);
    expect(outcome.connection).toBe("direct");
    expect(platform.receipts).toHaveLength(1);
    expect(verifyReceiptSignature(outcome.receipt.receipt, buyer.keys.publicKey, outcome.receipt.requesterSignature)).toBe(true);
  });
});
