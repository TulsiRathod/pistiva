import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { DiscoveredAgent, PlatformClient } from "@pistiva/agent-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakePlatform, type FakeAgent } from "../../../packages/gateway/test/fake-platform.ts";
import type { KitConfig } from "../server/config.ts";
import { createPool, migrate, type Db } from "../server/db.ts";
import { JobQueue } from "../server/jobs.ts";
import { createKit, type Kit } from "../server/kit.ts";
import { PgNonceStore } from "../server/repo.ts";

const PASSWORD = "operator-password-1";

describe("Partner Kit reliability", { timeout: 180_000 }, () => {
  let pg: StartedPostgreSqlContainer;
  let platform: FakePlatform;
  let buyerAgent: FakeAgent;
  let supplierAgent: FakeAgent;
  const pools: Db[] = [];
  let supplier: Kit;
  let supplierDb: Db;
  let buyerDb: Db;
  let card: DiscoveredAgent;
  let failReceipts = false;

  async function database(name: string): Promise<Db> {
    const admin = createPool(pg.getConnectionUri());
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const db = createPool(pg.getConnectionUri().replace(/\/[^/]+$/, `/${name}`));
    pools.push(db);
    return db;
  }

  function node(self: FakeAgent, peer: FakeAgent, discovered: () => DiscoveredAgent[]): PlatformClient {
    const client = platform.clientFor(self, peer, []);
    const submit = client.submitReceipt.bind(client);
    return Object.assign(client, {
      discover: async () => discovered(),
      publishCard: async () => undefined,
      // Lets a test make the platform refuse receipts, as if it were down.
      submitReceipt: async (r: Parameters<typeof submit>[0]) => {
        if (failReceipts) throw new Error("platform unavailable");
        return submit(r);
      },
    });
  }

  const buyerCfg: KitConfig = { agent: { name: "Buyer" }, connectors: {}, provides: {}, requests: ["quote.request"] };

  async function startBuyer(): Promise<{ kit: Kit; url: string; token: string }> {
    const kit = await createKit({
      cfg: buyerCfg,
      db: buyerDb,
      platform: node(buyerAgent, supplierAgent, () => [card]),
      keys: buyerAgent.keys,
      agentId: buyerAgent.agentId,
      orgId: buyerAgent.orgId,
      kid: buyerAgent.kid,
      publicUrl: "http://placeholder",
      adminPassword: PASSWORD,
      publishCard: false,
      maintenanceMs: 3_600_000, // tests trigger maintenance jobs explicitly
    });
    await kit.app.listen({ port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${(kit.app.server.address() as AddressInfo).port}`;
    const token = ((await (await fetch(`${url}/ui/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) })).json()) as { token: string }).token;
    return { kit, url, token };
  }

  async function ui<T>(b: { url: string; token: string }, path: string, body?: unknown): Promise<T> {
    const res = await fetch(b.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${b.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await res.json()) as T;
  }

  async function questionFor(b: { url: string; token: string }): Promise<{ id: number; taskId: string }> {
    for (let i = 0; i < 100; i++) {
      const [q] = await ui<{ id: number; taskId: string }[]>(b, "/ui/questions");
      if (q) return q;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("no question");
  }

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    platform = new FakePlatform();
    buyerAgent = platform.registerAgent();
    supplierAgent = platform.registerAgent();
    const dir = await mkdtemp(join(tmpdir(), "pistiva-rel-"));
    await writeFile(join(dir, "inventory.json"), JSON.stringify([{ sku: "NUT-M8", name: "Hex nut M8, zinc", stockOnHand: 30000, listPrice: "1.10" }]));
    supplierDb = await database("rel_supplier");
    supplier = await createKit({
      cfg: {
        agent: { name: "Supplier" },
        connectors: { inventory: { type: "json-file", path: join(dir, "inventory.json") } },
        provides: { "quote.request": { module: "inventory-quote", connector: "inventory" } },
        requests: [],
      },
      db: supplierDb,
      platform: node(supplierAgent, buyerAgent, () => []),
      keys: supplierAgent.keys,
      agentId: supplierAgent.agentId,
      orgId: supplierAgent.orgId,
      kid: supplierAgent.kid,
      publicUrl: "http://placeholder",
      adminPassword: PASSWORD,
      publishCard: false,
    });
    await supplier.app.listen({ port: 0, host: "127.0.0.1" });
    const endpoint = `http://127.0.0.1:${(supplier.app.server.address() as AddressInfo).port}`;
    card = {
      agentId: supplierAgent.agentId,
      orgId: supplierAgent.orgId,
      orgName: "Supplier Co",
      orgDomain: "supplier.example",
      orgVerified: true,
      kid: supplierAgent.kid,
      signature: "",
      publicKey: supplierAgent.keys.publicKey,
      card: { agentId: supplierAgent.agentId, orgId: supplierAgent.orgId, kid: supplierAgent.kid, name: "Supplier", version: "1", endpoint, protocols: [], capabilities: [{ name: "quote.request", version: 1 }], issuedAt: 1 },
    };
    buyerDb = await database("rel_buyer");
  }, 180_000);

  afterAll(async () => {
    await supplier?.close();
    await Promise.all(pools.map((p) => p.end()));
    await pg?.stop();
  });

  it("job queue retries with backoff, gives up after the limit, and de-duplicates recurring jobs", async () => {
    const db = await database("rel_jobs");
    await migrate(db);
    const jobs = new JobQueue(db);
    let flaky = 0;
    jobs.register("flaky", async () => {
      if (++flaky < 2) throw new Error("transient");
    });
    jobs.register("broken", async () => {
      throw new Error("always");
    });
    await jobs.enqueue("flaky");
    await jobs.enqueue("broken", {}, { maxAttempts: 2 });
    await jobs.drain();
    // Both failed once and were rescheduled with a backoff; make them due now.
    await db.query("UPDATE kit_jobs SET run_at = now() WHERE status = 'pending'");
    await jobs.drain();
    const { rows } = await db.query("SELECT kind, status, attempts, last_error FROM kit_jobs ORDER BY kind");
    expect(rows).toEqual([
      { kind: "broken", status: "failed", attempts: 2, last_error: "always" },
      { kind: "flaky", status: "done", attempts: 2, last_error: null },
    ]);

    await jobs.enqueue("flaky", {}, { uniqueKey: "only-one", delayMs: 60_000 });
    await jobs.enqueue("flaky", {}, { uniqueKey: "only-one", delayMs: 60_000 });
    expect((await db.query("SELECT count(*)::int AS n FROM kit_jobs WHERE unique_key = 'only-one'")).rows[0].n).toBe(1);

    // A job locked by a process that died is picked up again.
    await db.query("UPDATE kit_jobs SET status = 'running', locked_at = now() - interval '10 minutes', run_at = now() WHERE unique_key = 'only-one'");
    expect(await jobs.drain()).toBe(1);
  });

  it("shares replay protection between replicas through the node's database", async () => {
    const db = await database("rel_nonces");
    await migrate(db);
    const [a, b] = [new PgNonceStore(db), new PgNonceStore(db)];
    const exp = Math.floor(Date.now() / 1000) + 60;
    expect(await a.firstUse("agent-1:n-1", exp)).toBe(true);
    expect(await b.firstUse("agent-1:n-1", exp)).toBe(false);
    expect(await b.firstUse("agent-1:n-2", exp)).toBe(true);

    await db.query("UPDATE gateway_nonces SET expires_at = now() - interval '1 hour' WHERE nonce = 'agent-1:n-1'");
    expect(await a.prune()).toBe(1);
    expect((await db.query("SELECT nonce FROM gateway_nonces")).rows).toEqual([{ nonce: "agent-1:n-2" }]);
  });

  it("keeps a supplier's question answerable across a buyer node restart", async () => {
    const first = await startBuyer();
    await ui(first, "/ui/outbound", { capability: "quote.request", request: { sku: "NUT-M8", qty: 40000 }, budget: "50.00", currency: "INR" });
    const q = await questionFor(first);
    await first.kit.outbound.idle();
    await first.kit.close(); // the process goes away while the supplier waits

    const second = await startBuyer();
    expect((await ui<{ ok?: boolean }>(second, `/ui/questions/${q.id}/answer`, { answer: "backorder" })).ok).toBe(true);
    await second.kit.outbound.idle();
    const task = (await ui<{ task: { state: string; rounds: number; summary: string } }>(second, `/ui/tasks/${q.taskId}`)).task;
    expect(task).toMatchObject({ state: "completed", rounds: 2 });
    expect(task.summary).toContain("14 days");
    await second.kit.close();
  });

  it("cancels the task at the supplier when nobody answers in time", async () => {
    const b = await startBuyer();
    await ui(b, "/ui/outbound", { capability: "quote.request", request: { sku: "NUT-M8", qty: 50000 }, budget: "50.00", currency: "INR" });
    const q = await questionFor(b);
    await b.kit.outbound.idle();
    await buyerDb.query("UPDATE kit_questions SET created_at = now() - interval '25 hours' WHERE id = $1", [q.id]);
    await b.kit.jobs.enqueue("questions.expire");
    await b.kit.jobs.drain();

    const task = (await ui<{ task: { state: string; summary: string } }>(b, `/ui/tasks/${q.taskId}`)).task;
    expect(task).toMatchObject({ state: "canceled", summary: "No answer within 24 hours" });
    const atSupplier = (await supplierDb.query("SELECT data FROM gateway_tasks WHERE id = $1", [q.taskId])).rows[0].data;
    expect(atSupplier.state).toBe("canceled");
    expect((await ui<{ id: number; status: string }[]>(b, "/ui/questions?status=all")).find((x) => x.id === q.id)?.status).toBe("expired");
    await b.kit.close();
  });

  it("re-submits receipts the platform refused, and recovers a stalled task's outcome from the supplier", async () => {
    const b = await startBuyer();
    failReceipts = true;
    await ui(b, "/ui/outbound", { capability: "quote.request", request: { sku: "NUT-M8", qty: 10 }, budget: "50.00", currency: "INR" });
    await b.kit.outbound.idle();
    failReceipts = false;
    const [task] = await ui<{ id: string; state: string }[]>(b, "/ui/tasks?direction=outbound");
    const before = (await ui<{ receipts: { recorded: boolean }[] }>(b, `/ui/tasks/${task!.id}`)).receipts;
    expect(before.map((r) => r.recorded)).toEqual([false]);
    const submitted = platform.receipts.length;
    await b.kit.jobs.enqueue("receipts.resubmit");
    await b.kit.jobs.drain();
    expect((await ui<{ receipts: { recorded: boolean }[] }>(b, `/ui/tasks/${task!.id}`)).receipts.map((r) => r.recorded)).toEqual([true]);
    expect(platform.receipts.length).toBe(submitted + 1);

    // Pretend the buyer lost track of the task mid-flight: recovery asks the supplier what happened.
    await buyerDb.query("UPDATE kit_tasks SET state = 'submitted', updated_at = now() - interval '20 minutes' WHERE id = $1", [task!.id]);
    await b.kit.jobs.enqueue("outbound.recover");
    await b.kit.jobs.drain();
    expect((await ui<{ task: { state: string } }>(b, `/ui/tasks/${task!.id}`)).task.state).toBe("completed");
    await b.kit.close();
  });
});
