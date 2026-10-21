import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { DiscoveredAgent, PlatformClient } from "@pistiva/agent-sdk";
import { ScriptedProvider, type LlmRequest } from "@pistiva/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakePlatform, type FakeAgent } from "../../../packages/gateway/test/fake-platform.ts";
import { createPool, type Db } from "../server/db.ts";
import { createKit, type Kit } from "../server/kit.ts";

const PASSWORD = "operator-password-1";

/** Stands in for the model: answers by prompt, and records what each prompt was shown. */
function scripted(): ScriptedProvider {
  return new ScriptedProvider((req: LlmRequest) => {
    switch (req.promptId) {
      case "request-interpreter@1":
        return { sku: "NUT-M8", qty: 40000, uom: "EA", deliverBy: "", specs: "", missing: [] };
      case "clarification-advisor@1": {
        const options = [...req.user.matchAll(/^- (.+)$/gm)].map((m) => m[1]!);
        const answer = options.includes("backorder") ? "backorder" : options[0]!;
        return { answer, rationale: "Matches the item you asked for.", confidence: "high" };
      }
      case "spec-check@1":
        return req.user.includes("stainless") ? { matches: false, concern: "It is zinc plated, not stainless." } : { matches: true, concern: "" };
      default:
        throw new Error(`unexpected prompt ${req.promptId}`);
    }
  });
}

describe("Partner Kit AI layer", { timeout: 120_000 }, () => {
  let pg: StartedPostgreSqlContainer;
  let platform: FakePlatform;
  let buyerAgent: FakeAgent;
  let supplierAgent: FakeAgent;
  let dbs: Db[] = [];
  let supplier: Kit;
  let buyer: Kit;
  let buyerUrl: string;
  let token: string;
  const buyerModel = scripted();
  const supplierModel = scripted();

  async function database(name: string): Promise<Db> {
    const admin = createPool(pg.getConnectionUri());
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const db = createPool(pg.getConnectionUri().replace(/\/[^/]+$/, `/${name}`));
    dbs.push(db);
    return db;
  }

  const node = (self: FakeAgent, peer: FakeAgent, discovered: () => DiscoveredAgent[]): PlatformClient =>
    Object.assign(platform.clientFor(self, peer, []), { discover: async () => discovered(), publishCard: async () => undefined });

  async function ui<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(buyerUrl + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await res.json()) as T;
  }

  async function eventually<T>(fn: () => Promise<T | undefined>): Promise<T> {
    for (let i = 0; i < 150; i++) {
      const v = await fn();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("timed out");
  }

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    platform = new FakePlatform();
    buyerAgent = platform.registerAgent();
    supplierAgent = platform.registerAgent();
    const dir = await mkdtemp(join(tmpdir(), "pistiva-ai-"));
    await writeFile(
      join(dir, "inventory.json"),
      JSON.stringify([
        { sku: "NUT-M8", name: "Hex nut M8, zinc", stockOnHand: 30000, listPrice: "1.10", costPrice: "0.55" },
        { sku: "BOLT-M8-50", name: "Hex bolt M8 x 50 mm, zinc", stockOnHand: 12000, listPrice: "4.20", costPrice: "2.65" },
      ]),
    );
    supplier = await createKit({
      cfg: {
        agent: { name: "Supplier" },
        connectors: { inventory: { type: "json-file", path: join(dir, "inventory.json") } },
        provides: { "quote.request": { module: "inventory-quote", connector: "inventory" } },
        requests: [],
        ai: { rag: { embedder: "hash" }, specCheck: true },
      },
      db: await database("ai_supplier"),
      platform: node(supplierAgent, buyerAgent, () => []),
      keys: supplierAgent.keys,
      agentId: supplierAgent.agentId,
      orgId: supplierAgent.orgId,
      kid: supplierAgent.kid,
      publicUrl: "http://placeholder",
      adminPassword: PASSWORD,
      publishCard: false,
      llmProvider: supplierModel,
    });
    await supplier.app.listen({ port: 0, host: "127.0.0.1" });
    const supplierUrl = `http://127.0.0.1:${(supplier.app.server.address() as AddressInfo).port}`;
    const card = {
      agentId: supplierAgent.agentId,
      orgId: supplierAgent.orgId,
      orgName: "Supplier Co",
      orgDomain: "supplier.example",
      orgVerified: true,
      kid: supplierAgent.kid,
      signature: "",
      publicKey: supplierAgent.keys.publicKey,
      card: { agentId: supplierAgent.agentId, orgId: supplierAgent.orgId, kid: supplierAgent.kid, name: "Supplier", version: "1", endpoint: supplierUrl, protocols: [], capabilities: [{ name: "quote.request", version: 1 }], issuedAt: 1 },
    } as DiscoveredAgent;

    buyer = await createKit({
      cfg: { agent: { name: "Buyer" }, connectors: {}, provides: {}, requests: ["quote.request"], ai: { preferences: "Prefer the full quantity even if it ships later." } },
      db: await database("ai_buyer"),
      platform: node(buyerAgent, supplierAgent, () => [card]),
      keys: buyerAgent.keys,
      agentId: buyerAgent.agentId,
      orgId: buyerAgent.orgId,
      kid: buyerAgent.kid,
      publicUrl: "http://placeholder",
      adminPassword: PASSWORD,
      publishCard: false,
      llmProvider: buyerModel,
    });
    await buyer.app.listen({ port: 0, host: "127.0.0.1" });
    buyerUrl = `http://127.0.0.1:${(buyer.app.server.address() as AddressInfo).port}`;
    token = ((await (await fetch(`${buyerUrl}/ui/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) })).json()) as { token: string }).token;
  }, 180_000);

  afterAll(async () => {
    await buyer?.close();
    await supplier?.close();
    await Promise.all(dbs.map((d) => d.end()));
    await pg?.stop();
  });

  it("drafts a contract-valid quote.request from a description for the operator to review", async () => {
    const out = await ui<{ request: Record<string, unknown>; missing: string[]; promptId: string }>("/ui/interpret", { text: "We need forty thousand M8 nuts" });
    expect(out).toMatchObject({ request: { sku: "NUT-M8", qty: 40000, uom: "EA" }, missing: [], promptId: "request-interpreter@1" });
    // Nothing was sent: drafting a request is not sending it.
    expect(await ui<unknown[]>("/ui/tasks?direction=outbound")).toEqual([]);
  });

  it("resolves an unknown SKU through catalog search, with a suggested answer at each question", async () => {
    await ui("/ui/outbound", { capability: "quote.request", request: { sku: "M8-HEXNUT", qty: 40000 }, budget: "50.00", currency: "INR" });

    type Q = { id: number; question: { question: string; options: string[] }; suggestion: { answer: string; suspicious: boolean } | null };
    const first = await eventually(async () => (await ui<Q[]>("/ui/questions")).find((q) => q.suggestion));
    expect(first.question.question).toContain("Did you mean");
    expect(first.question.options).toContain("NUT-M8");
    expect(first.suggestion!.answer).toBe("NUT-M8");
    await ui(`/ui/questions/${first.id}/answer`, { answer: first.suggestion!.answer });

    const second = await eventually(async () => (await ui<Q[]>("/ui/questions")).find((q) => q.id !== first.id && q.suggestion));
    expect(second.question.options).toEqual(["partial", "backorder"]);
    expect(second.suggestion!.answer).toBe("backorder");
    await ui(`/ui/questions/${second.id}/answer`, { answer: "backorder" });
    await buyer.outbound.idle();

    const [task] = await ui<{ state: string; rounds: number; summary: string }[]>("/ui/tasks?direction=outbound");
    expect(task).toMatchObject({ state: "completed", rounds: 3 });
    expect(task!.summary).toContain("40000");
  });

  it("asks before quoting when the buyer's specs conflict with the item", async () => {
    await ui("/ui/outbound", { capability: "quote.request", request: { sku: "BOLT-M8-50", qty: 10, specs: "A2 stainless steel" }, budget: "50.00", currency: "INR" });
    type Q = { id: number; question: { question: string; options: string[] } };
    const q = await eventually(async () => (await ui<Q[]>("/ui/questions")).find((x) => x.question.options.includes("quote as is")));
    expect(q.question.question).toContain("zinc plated");
    // The spec check saw only public item text.
    const specCall = supplierModel.calls.find((c) => c.promptId === "spec-check@1")!;
    expect(specCall.user).not.toMatch(/costPrice|0\.55|2\.65|stockOnHand/);
    await ui(`/ui/questions/${q.id}/answer`, { decline: true });
    await buyer.outbound.idle();
  });

  it("meters every model call by prompt version", async () => {
    const ai = await ui<{ llm: string; rag: boolean; usage: { promptId: string; calls: number }[] }>("/ui/ai");
    expect(ai.llm).toBe("scripted");
    expect(ai.usage.map((u) => u.promptId)).toEqual(expect.arrayContaining(["request-interpreter@1", "clarification-advisor@1"]));
  });
});
