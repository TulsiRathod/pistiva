import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { DiscoveredAgent, PlatformClient } from "@pistiva/agent-sdk";
import { CsvFileInventory } from "@pistiva/procurement";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakePlatform, type FakeAgent } from "../../../packages/gateway/test/fake-platform.ts";
import type { KitConfig } from "../server/config.ts";
import { McpInventory } from "../server/connectors.ts";
import { createPool, type Db } from "../server/db.ts";
import { createKit, type Kit } from "../server/kit.ts";

const PASSWORD = "operator-password-1";
const INVENTORY = [
  { sku: "BOLT-M8-50", name: "Hex bolt", stockOnHand: 12000, listPrice: "4.20", costPrice: "2.65", warehouse: "Pune-2", supplierNotes: "secret" },
  { sku: "NUT-M8", name: "Hex nut", stockOnHand: 30000, listPrice: "1.10", costPrice: "0.55", warehouse: "Pune-2", supplierNotes: "" },
];

describe("Partner Kit", { timeout: 120_000 }, () => {
  let pg: StartedPostgreSqlContainer;
  let platform: FakePlatform;
  let buyerAgent: FakeAgent;
  let supplierAgent: FakeAgent;
  let supplierDb: Db;
  let buyerDb: Db;
  let supplier: Kit;
  let buyer: Kit;
  let supplierUrl: string;
  let buyerUrl: string;
  let supplierCfg: KitConfig;
  let dir: string;
  const extraDiscovered: DiscoveredAgent[] = [];

  async function database(name: string): Promise<Db> {
    const admin = createPool(pg.getConnectionUri());
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    return createPool(pg.getConnectionUri().replace(/\/[^/]+$/, `/${name}`));
  }

  function nodePlatform(self: FakeAgent, peer: FakeAgent, discovered: () => DiscoveredAgent[]): PlatformClient {
    const client = platform.clientFor(self, peer, []);
    return Object.assign(client, { discover: async () => discovered(), publishCard: async () => undefined });
  }

  async function login(base: string): Promise<string> {
    const res = await fetch(`${base}/ui/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
    return ((await res.json()) as { token: string }).token;
  }

  async function ui<T>(base: string, path: string, token: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(base + path, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    return (await res.json()) as T;
  }

  async function eventually<T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
    const until = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() > until) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:16-alpine").start();
    platform = new FakePlatform();
    buyerAgent = platform.registerAgent();
    supplierAgent = platform.registerAgent();
    dir = await mkdtemp(join(tmpdir(), "pistiva-kit-"));
    await writeFile(join(dir, "inventory.json"), JSON.stringify(INVENTORY));

    supplierCfg = {
      agent: { name: "Supplier node" },
      connectors: { inventory: { type: "json-file", path: join(dir, "inventory.json") } },
      provides: {
        "quote.request": { module: "inventory-quote", connector: "inventory" },
        "order.draft": { module: "order-draft" },
        "order.confirm": { module: "order-confirm" },
      },
      requests: [],
    };
    supplierDb = await database("supplier");
    supplier = await createKit({
      cfg: supplierCfg,
      db: supplierDb,
      platform: nodePlatform(supplierAgent, buyerAgent, () => []),
      keys: supplierAgent.keys,
      agentId: supplierAgent.agentId,
      orgId: supplierAgent.orgId,
      kid: supplierAgent.kid,
      publicUrl: "http://placeholder",
      adminPassword: PASSWORD,
      publishCard: false,
    });
    await supplier.app.listen({ port: 0, host: "127.0.0.1" });
    supplierUrl = `http://127.0.0.1:${(supplier.app.server.address() as AddressInfo).port}`;

    const discovered = (): DiscoveredAgent[] => [
      {
        agentId: supplierAgent.agentId,
        orgId: supplierAgent.orgId,
        orgName: "Supplier Co",
        orgDomain: "supplier.example",
        orgVerified: true,
        kid: supplierAgent.kid,
        signature: "",
        publicKey: supplierAgent.keys.publicKey,
        card: {
          agentId: supplierAgent.agentId,
          orgId: supplierAgent.orgId,
          kid: supplierAgent.kid,
          name: "Supplier node",
          version: "0.1.0",
          endpoint: supplierUrl,
          protocols: ["a2a/0.3"],
          capabilities: [{ name: "quote.request", version: 1 }, { name: "order.draft", version: 1 }, { name: "order.confirm", version: 1 }],
          issuedAt: 1,
        },
      },
    ];
    buyerDb = await database("buyer");
    buyer = await createKit({
      cfg: { agent: { name: "Buyer node" }, connectors: {}, provides: {}, requests: ["quote.request", "order.draft"] },
      db: buyerDb,
      platform: nodePlatform(buyerAgent, supplierAgent, () => [...discovered(), ...extraDiscovered]),
      keys: buyerAgent.keys,
      agentId: buyerAgent.agentId,
      orgId: buyerAgent.orgId,
      kid: buyerAgent.kid,
      publicUrl: "http://placeholder",
      adminPassword: PASSWORD,
      publishCard: false,
    });
    await buyer.app.listen({ port: 0, host: "127.0.0.1" });
    buyerUrl = `http://127.0.0.1:${(buyer.app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await buyer?.close();
    await supplier?.close();
    await buyerDb?.end();
    await supplierDb?.end();
    await pg?.stop();
  });

  it("requires an operator session for the node's API", async () => {
    expect((await fetch(`${buyerUrl}/ui/tasks`)).status).toBe(401);
    const bad = await fetch(`${buyerUrl}/ui/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "nope" }) });
    expect(bad.status).toBe(401);
  });

  it("runs a quote end to end, with an operator answering the supplier's question", async () => {
    const token = await login(buyerUrl);
    const started = await ui<{ providers: { agentId: string }[] }>(buyerUrl, "/ui/outbound", token, {
      method: "POST",
      body: JSON.stringify({ capability: "quote.request", request: { sku: "NUT-M8", qty: 40000 }, budget: "50.00", currency: "INR" }),
    });
    expect(started.providers.map((p) => p.agentId)).toEqual([supplierAgent.agentId]);

    const question = await eventually(async () => (await ui<{ id: number; question: { options: string[] } }[]>(buyerUrl, "/ui/questions", token))[0]);
    expect(question.question.options).toEqual(["partial", "backorder"]);
    await ui(buyerUrl, `/ui/questions/${question.id}/answer`, token, { method: "POST", body: JSON.stringify({ answer: "backorder" }) });
    await buyer.outbound.idle();

    const [task] = await ui<{ id: string; state: string; rounds: number; summary: string }[]>(buyerUrl, "/ui/tasks?direction=outbound", token);
    expect(task!.state).toBe("completed");
    expect(task!.rounds).toBe(2);
    expect(task!.summary).toContain("14 days");

    const detail = await ui<{ messages: { sender: string; kind: string }[]; receipts: { round: number; countersigned: boolean; recorded: boolean }[] }>(
      buyerUrl, `/ui/tasks/${task!.id}`, token);
    expect(detail.messages.map((m) => `${m.sender}:${m.kind}`)).toEqual(["us:request", "peer:clarification", "us:answer", "peer:result"]);
    expect(detail.receipts.map((r) => [r.round, r.countersigned, r.recorded])).toEqual([[1, true, true], [2, true, true]]);
    expect(platform.receipts).toHaveLength(2);

    // The supplier's node holds its own record, including which private fields it withheld.
    const sToken = await login(supplierUrl);
    const inbound = await ui<{ id: string; state: string }[]>(supplierUrl, "/ui/tasks?direction=inbound", sToken);
    expect(inbound[0]!.state).toBe("completed");
    const sDetail = await ui<{ messages: { sender: string; kind: string; withheld: string[] | null }[]; receipts: { countersigned: boolean }[] }>(
      supplierUrl, `/ui/tasks/${inbound[0]!.id}`, sToken);
    const result = sDetail.messages.find((m) => m.sender === "us" && m.kind === "result")!;
    expect(result.withheld).toEqual(expect.arrayContaining(["costPrice", "warehouse", "supplierNotes", "stockOnHand"]));
    expect(await eventually(async () => (sDetail.receipts.every((r) => r.countersigned) ? true : undefined))).toBe(true);
  });

  it("applies an operator's narrower disclosure to the next quote", async () => {
    const sToken = await login(supplierUrl);
    const updated = await ui<{ allowed: string[] }>(supplierUrl, "/ui/disclosure/quote.request", sToken, {
      method: "PUT",
      body: JSON.stringify({ fields: ["sku", "available", "unitPrice", "currency", "costPrice"] }),
    });
    expect(updated.allowed).toEqual(["sku", "available", "unitPrice", "currency"]); // costPrice is not in the contract

    const token = await login(buyerUrl);
    await ui(buyerUrl, "/ui/outbound", token, {
      method: "POST",
      body: JSON.stringify({ capability: "quote.request", request: { sku: "BOLT-M8-50", qty: 10 }, budget: "50.00", currency: "INR" }),
    });
    await buyer.outbound.idle();
    const [latest] = await ui<{ id: string }[]>(buyerUrl, "/ui/tasks?direction=outbound", token);
    const detail = await ui<{ messages: { sender: string; kind: string; data: Record<string, unknown> }[] }>(buyerUrl, `/ui/tasks/${latest!.id}`, token);
    const result = detail.messages.find((m) => m.sender === "peer" && m.kind === "result")!;
    expect(Object.keys(result.data).sort()).toEqual(["available", "currency", "sku", "unitPrice"]);
  });

  it("closes a granted task as failed when the supplier is unreachable", async () => {
    const offline = platform.registerAgent();
    extraDiscovered.push({
      agentId: offline.agentId,
      orgId: offline.orgId,
      orgName: "Offline Co",
      orgDomain: "offline.example",
      orgVerified: true,
      kid: offline.kid,
      signature: "",
      publicKey: offline.keys.publicKey,
      card: { agentId: offline.agentId, orgId: offline.orgId, kid: offline.kid, name: "Offline", version: "1", endpoint: "http://127.0.0.1:9", protocols: [], capabilities: [{ name: "quote.request", version: 1 }], issuedAt: 1 },
    });
    const token = await login(buyerUrl);
    await ui(buyerUrl, "/ui/outbound", token, {
      method: "POST",
      body: JSON.stringify({ capability: "quote.request", request: { sku: "BOLT-M8-50", qty: 1 }, budget: "5.00", currency: "INR", providerAgentIds: [offline.agentId] }),
    });
    await buyer.outbound.idle();
    const tasks = await ui<{ id: string; peerAgentId: string; state: string; error: string | null }[]>(buyerUrl, "/ui/tasks?direction=outbound", token);
    const offlineTasks = tasks.filter((t) => t.peerAgentId === offline.agentId);
    expect(offlineTasks).toHaveLength(1);
    expect(offlineTasks[0]).toMatchObject({ state: "failed" });
    expect(offlineTasks[0]!.id.startsWith("local-")).toBe(false);
    expect(offlineTasks[0]!.error).toBeTruthy();
    extraDiscovered.length = 0;
  });

  it("commits a large order only after a human approval, and a small one directly", async () => {
    const token = await login(buyerUrl);
    async function draft(qty: number): Promise<string> {
      await ui(buyerUrl, "/ui/outbound", token, {
        method: "POST",
        body: JSON.stringify({
          capability: "order.draft",
          request: { quoteTaskId: "00000000-0000-4000-8000-000000000001", sku: "NUT-M8", qty, unitPrice: "1.10", currency: "INR" },
          budget: "50000.00",
          currency: "INR",
          providerAgentIds: [supplierAgent.agentId],
        }),
      });
      await buyer.outbound.idle();
      const tasks = await ui<{ id: string; capability: string; state: string }[]>(buyerUrl, "/ui/tasks?direction=outbound", token);
      return tasks.find((t) => t.capability === "order.draft" && t.state === "completed")!.id;
    }
    type C = { status: string; approvalId: string | null; note: string | null; orderRef: string };
    const commit = (id: string) => ui<C>(buyerUrl, `/ui/tasks/${id}/commit`, token, { method: "POST", body: "{}" });

    // 20000 x 1.10 = 22000.00, above the 10000.00 threshold: the node files an approval and waits.
    const big = await draft(20000);
    const pending = await commit(big);
    expect(pending.status).toBe("awaiting_approval");
    expect(platform.approvals.get(pending.approvalId!)).toMatchObject({ amount: "22000.00", capability: "order.confirm", status: "PENDING" });
    await buyer.commitments.poll();
    expect(await commit(big)).toMatchObject({ error: "conflict" }); // already waiting for approval
    platform.decide(pending.approvalId!, "APPROVED");
    await buyer.commitments.poll();
    const done = (await ui<{ commitment: C }>(buyerUrl, `/ui/tasks/${big}`, token)).commitment;
    expect(done.status).toBe("confirmed");
    const { rows } = await supplierDb.query("SELECT data FROM kit_drafts WHERE order_ref = $1", [done.orderRef]);
    expect(rows[0].data.status).toBe("confirmed");

    // A rejected approval never reaches the supplier.
    const second = await draft(15000);
    const waiting = await commit(second);
    platform.decide(waiting.approvalId!, "REJECTED", "Over the quarterly budget");
    await buyer.commitments.poll();
    const rejected = (await ui<{ commitment: C }>(buyerUrl, `/ui/tasks/${second}`, token)).commitment;
    expect(rejected).toMatchObject({ status: "approval_rejected", note: "Over the quarterly budget" });
    const { rows: still } = await supplierDb.query("SELECT data FROM kit_drafts WHERE order_ref = $1", [rejected.orderRef]);
    expect(still[0].data.status).toBe("draft");

    // Below the threshold no approval is needed.
    const small = await draft(100);
    expect((await commit(small)).status).toBe("confirmed");
  });

  it("reports connector health and keeps its records across a restart", async () => {
    const sToken = await login(supplierUrl);
    const connectors = await ui<{ name: string; ok: boolean; items: number }[]>(supplierUrl, "/ui/connectors", sToken);
    expect(connectors).toEqual([expect.objectContaining({ name: "inventory", ok: true, items: 2 })]);

    const before = (await supplier.repo.listTasks("inbound")).length;
    const restarted = await createKit({
      cfg: supplierCfg,
      db: supplierDb,
      platform: nodePlatform(supplierAgent, buyerAgent, () => []),
      keys: supplierAgent.keys,
      agentId: supplierAgent.agentId,
      orgId: supplierAgent.orgId,
      kid: supplierAgent.kid,
      publicUrl: "http://placeholder",
      adminPassword: PASSWORD,
      publishCard: false,
    });
    expect(before).toBeGreaterThan(0);
    expect((await restarted.repo.listTasks("inbound")).length).toBe(before);
    // The operator's disclosure choice survived the restart too.
    expect(await restarted.repo.getSetting("disclosure:quote.request")).toEqual(["sku", "available", "unitPrice", "currency"]);
    // Operator sessions are per process unless KIT_SESSION_SECRET is set, so the old token is refused.
    const stale = await restarted.app.inject({ method: "GET", url: "/ui/disclosure", headers: { authorization: `Bearer ${sToken}` } });
    expect(stale.statusCode).toBe(401);
    await restarted.close();
  });

  it("reads inventory from CSV and from an MCP server", async () => {
    const csv = join(dir, "inventory.csv");
    await writeFile(csv, 'sku,name,stockOnHand,listPrice,costPrice\nBOLT-M8-50,"Hex bolt, zinc",12000,4.20,2.65\n');
    expect(await new CsvFileInventory(csv).find("BOLT-M8-50")).toMatchObject({ name: "Hex bolt, zinc", stockOnHand: 12000 });

    const server = fileURLToPath(new URL("../examples/mcp-inventory-server.ts", import.meta.url));
    const mcp = new McpInventory({
      type: "mcp",
      command: process.execPath,
      args: ["--import", "tsx", server],
      tool: "lookup_sku",
      env: { INVENTORY_FILE: join(dir, "inventory.json") },
    });
    try {
      expect(await mcp.health()).toMatchObject({ ok: true });
      expect(await mcp.find("NUT-M8")).toMatchObject({ sku: "NUT-M8", stockOnHand: 30000 });
      expect(await mcp.find("MISSING")).toBeUndefined();
    } finally {
      await mcp.close();
    }
  });
});
