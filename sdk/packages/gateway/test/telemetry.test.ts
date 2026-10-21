import type { AddressInfo } from "node:net";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { A2A_PATH, A2AClient, dataPart, type AgentCard, type DiscoveredAgent } from "@pistiva/agent-sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProviderGateway, SpanAttr } from "../src/index.ts";
import { FakePlatform } from "./fake-platform.ts";

describe("gateway tracing", () => {
  const exporter = new InMemorySpanExporter();
  const contextManager = new AsyncLocalStorageContextManager().enable();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  let app: FastifyInstance;
  let endpoint: string;
  const platform = new FakePlatform();
  const buyer = platform.registerAgent();
  const supplier = platform.registerAgent();

  beforeAll(async () => {
    context.setGlobalContextManager(contextManager);
    trace.setGlobalTracerProvider(provider);
    const card: AgentCard = {
      agentId: supplier.agentId,
      orgId: supplier.orgId,
      kid: supplier.kid,
      name: "Traced supplier",
      version: "1.0.0",
      endpoint: "http://placeholder",
      protocols: ["a2a/0.3"],
      capabilities: [{ name: "quote.request", version: 1, description: "Quotes" }],
      issuedAt: 1,
    };
    app = createProviderGateway({
      agentId: supplier.agentId,
      kid: supplier.kid,
      keys: supplier.keys,
      platform,
      card,
      capabilities: {
        "quote.request": {
          handle: () => ({ sku: "SECRET-SKU-1", available: true, unitPrice: "4.20", currency: "INR", validUntil: "2026-11-01", costPrice: "2.65" }),
        },
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    endpoint = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    card.endpoint = endpoint;
  });

  afterAll(async () => {
    await app.close();
    trace.disable();
    context.disable();
  });

  it("traces each round with the task id and counts, never the payload", async () => {
    const discovered = {
      agentId: supplier.agentId,
      orgId: supplier.orgId,
      orgName: "Traced supplier",
      kid: supplier.kid,
      publicKey: supplier.keys.publicKey,
      card: { endpoint, capabilities: [{ name: "quote.request", version: 1 }] },
    } as unknown as DiscoveredAgent;
    const client = new A2AClient({ platform: platform.clientFor(buyer, supplier, ["sku", "available", "unitPrice", "currency"]), keys: buyer.keys });
    const out = await client.run(discovered, "quote.request", { sku: "SECRET-SKU-1", qty: 3 }, { budget: "10.00", currency: "INR" });
    expect(out.state).toBe("completed");

    await fetch(endpoint + A2A_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { kind: "message", messageId: "m", role: "user", parts: [dataPart({ sku: "X", qty: 1 }, "request")] } } }),
    });

    const spans = exporter.getFinishedSpans().filter((s) => s.name === "pistiva.a2a message/send");
    expect(spans).toHaveLength(2);
    const [ok, rejected] = spans;
    expect(ok!.attributes).toMatchObject({
      [SpanAttr.taskId]: out.taskId,
      [SpanAttr.capability]: "quote.request",
      [SpanAttr.round]: 1,
      [SpanAttr.state]: "completed",
      [SpanAttr.fieldsDisclosed]: 4,
      [SpanAttr.fieldsWithheld]: 2,
      [SpanAttr.requesterAgent]: buyer.agentId,
    });
    expect(rejected!.attributes[SpanAttr.rejection]).toBeDefined();
    expect(rejected!.status.code).toBe(2);
    const everything = JSON.stringify(exporter.getFinishedSpans().map((s) => ({ name: s.name, attributes: s.attributes, events: s.events })));
    expect(everything).not.toContain("SECRET-SKU-1");
    expect(everything).not.toContain("4.20");
    expect(everything).not.toContain("2.65");
  });
});
