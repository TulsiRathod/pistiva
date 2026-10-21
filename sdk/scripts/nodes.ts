/**
 * Runs two Pistiva nodes (Partner Kits) against a live platform: a supplier and a buyer, each with
 * its own database, keys and operator UI.
 *   npm run nodes            # start both and keep running; open the printed URLs
 *   npm run nodes -- --check # run a quote with a clarification round through the operator API, certify the
 *                            # supplier node with the conformance suite, then exit
 * Needs Postgres reachable at NODES_DB_URL (default: the local compose database).
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PlatformClient } from "@pistiva/agent-sdk";
import { createPool, type Db } from "../apps/partner-kit/server/db.ts";
import { loadConfig } from "../apps/partner-kit/server/config.ts";
import { createKit, type Kit } from "../apps/partner-kit/server/kit.ts";
import { runConformance } from "../packages/certify/src/index.ts";
import { api, Bootstrapper, PLATFORM_URL, waitForPlatform, type Bootstrapped } from "./lib/bootstrap.ts";

const DB_URL = process.env.NODES_DB_URL ?? "postgres://pistiva:pistiva@localhost:5432/pistiva";
const OPERATOR_PASSWORD = process.env.KIT_ADMIN_PASSWORD ?? "operator-password";
const CHECK = process.argv.includes("--check");
const SUPPLIER_PORT = 9301;
const BUYER_PORT = 9302;

async function database(name: string): Promise<Db> {
  const admin = createPool(DB_URL);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return createPool(DB_URL.replace(/\/[^/]+$/, `/${name}`));
}

async function startNode(org: Bootstrapped, port: number, configText: string, dbName: string, configPath: string): Promise<{ kit: Kit; db: Db }> {
  await writeFile(configPath, configText);
  const cfg = await loadConfig(configPath);
  const db = await database(dbName);
  const platform = new PlatformClient({ baseUrl: PLATFORM_URL, agentId: org.agentId, kid: org.kid, keys: org.keys, statusTtlMs: 2_000 });
  const kit = await createKit({
    cfg,
    db,
    platform,
    keys: org.keys,
    agentId: org.agentId,
    orgId: org.orgId,
    kid: org.kid,
    publicUrl: `http://localhost:${port}`,
    adminPassword: OPERATOR_PASSWORD,
    // Matches infra/observability/prometheus.yml, so a local Prometheus can scrape the nodes.
    metricsToken: process.env.KIT_METRICS_TOKEN ?? "local-metrics-token",
  });
  await kit.app.listen({ port, host: "0.0.0.0" });
  return { kit, db };
}

async function ui<T>(port: number, path: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}

async function main() {
  await waitForPlatform();
  const boot = new Bootstrapper();
  const supplierOrg = await boot.org("vardhman", "Vardhman Steel Traders", `http://localhost:${SUPPLIER_PORT}`);
  const buyerOrg = await boot.org("orbit", "Orbit Machines", `http://localhost:${BUYER_PORT}`);
  const inventory = fileURLToPath(new URL("../apps/partner-kit/data/inventory.json", import.meta.url));

  const supplier = await startNode(
    supplierOrg,
    SUPPLIER_PORT,
    `agent: { name: Vardhman Steel Traders quote agent }
connectors: { inventory: { type: json-file, path: ${JSON.stringify(inventory)} } }
provides:
  quote.request: { module: inventory-quote, connector: inventory }
  order.draft: { module: order-draft }
requests: []
`,
    `node_supplier_${boot.run}`,
    `${boot.keyDir}/supplier.yaml`,
  );
  const buyer = await startNode(
    buyerOrg,
    BUYER_PORT,
    `agent: { name: Orbit Machines procurement agent }
connectors: {}
provides: {}
requests: [quote.request, order.draft]
outbound: { currency: INR, defaultBudget: "5000.00" }
`,
    `node_buyer_${boot.run}`,
    `${boot.keyDir}/buyer.yaml`,
  );

  console.log(`Supplier node: http://localhost:${SUPPLIER_PORT}   (operator password: ${OPERATOR_PASSWORD})`);
  console.log(`Buyer node:    http://localhost:${BUYER_PORT}`);

  if (!CHECK) {
    console.log("\nRunning. In the buyer node: Outbox → New request (e.g. NUT-M8 × 40000), then answer the supplier's question under Questions.");
    return;
  }

  let failures = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  };
  try {
    const token = (await ui<{ token: string }>(BUYER_PORT, "/ui/login", "", { password: OPERATOR_PASSWORD })).token;
    const started = await ui<{ providers: { agentId: string; orgName: string }[] }>(BUYER_PORT, "/ui/outbound", token, {
      capability: "quote.request",
      request: { sku: "NUT-M8", qty: 40000 },
      budget: "45000.00",
      currency: "INR",
      providerAgentIds: [supplierOrg.agentId],
    });
    check("buyer node sent the request to the supplier node", started.providers.length === 1, started.providers[0]?.orgName);

    let question: { id: number; question: { question: string } } | undefined;
    for (let i = 0; i < 100 && !question; i++) {
      question = (await ui<{ id: number; question: { question: string } }[]>(BUYER_PORT, "/ui/questions", token))[0];
      if (!question) await new Promise((r) => setTimeout(r, 200));
    }
    check("supplier's clarifying question reached the buyer's operator", !!question, question?.question.question);
    if (question) await ui(BUYER_PORT, `/ui/questions/${question.id}/answer`, token, { answer: "backorder" });
    await buyer.kit.outbound.idle();

    const [task] = await ui<{ id: string; state: string; rounds: number; summary: string; approvalRequired: boolean }[]>(BUYER_PORT, "/ui/tasks?direction=outbound", token);
    check("quote completed after the answer", task?.state === "completed" && task.rounds === 2, task?.summary);
    check("approval flag carried from the platform grant", task?.approvalRequired === true);
    const detail = await ui<{ receipts: { countersigned: boolean; recorded: boolean }[] }>(BUYER_PORT, `/ui/tasks/${task!.id}`, token);
    check("both rounds countersigned and recorded on the platform", detail.receipts.length === 2 && detail.receipts.every((r) => r.countersigned && r.recorded));

    const sToken = (await ui<{ token: string }>(SUPPLIER_PORT, "/ui/login", "", { password: OPERATOR_PASSWORD })).token;
    const [inbound] = await ui<{ id: string; state: string }[]>(SUPPLIER_PORT, "/ui/tasks?direction=inbound", sToken);
    const sDetail = await ui<{ messages: { sender: string; kind: string; withheld: string[] | null }[] }>(SUPPLIER_PORT, `/ui/tasks/${inbound!.id}`, sToken);
    const withheld = sDetail.messages.find((m) => m.sender === "us" && m.kind === "result")?.withheld ?? [];
    check("supplier node recorded what it withheld", withheld.includes("costPrice") && withheld.includes("stockOnHand"), withheld.join(", "));

    // A certifier organization runs the conformance suite against the supplier node over the network.
    const certifierOrg = await boot.org("certlab", "Pistiva Certification Lab", "http://localhost:9399");
    await api("PUT", `/admin/organizations/${certifierOrg.orgId}/certifier`, await boot.admin(), { certifier: true });
    const certifier = new PlatformClient({ baseUrl: PLATFORM_URL, agentId: certifierOrg.agentId, kid: certifierOrg.kid, keys: certifierOrg.keys, statusTtlMs: 0 });
    const target = (await certifier.discover("quote.request")).find((d) => d.agentId === supplierOrg.agentId);
    check("supplier node is not certified before the suite runs", target?.certified === false);
    const report = await runConformance({ platform: certifier, keys: certifierOrg.keys, provider: target!, capability: "quote.request", sample: { sku: "NUT-M8", qty: 100 } });
    const failed = report.checks.filter((c) => !c.passed);
    check("supplier node passes the conformance suite", report.passed, failed.length ? failed.map((c) => `${c.id}: ${c.detail}`).join("; ") : `${report.checks.length} checks`);
    const cert = await certifier.submitCertification(supplierOrg.agentId, report);
    check("certification recorded on the platform", cert.status === "PASSED" && cert.valid, `valid until ${cert.expiresAt.slice(0, 10)}`);
    const buyerPlatform = new PlatformClient({ baseUrl: PLATFORM_URL, agentId: buyerOrg.agentId, kid: buyerOrg.kid, keys: buyerOrg.keys });
    const certifiedOnly = await buyerPlatform.discover("quote.request", { certifiedOnly: true });
    check("buyers can discover only certified suppliers", certifiedOnly.some((d) => d.agentId === supplierOrg.agentId && d.certified));
  } finally {
    await buyer.kit.close();
    await supplier.kit.close();
    await buyer.db.end();
    await supplier.db.end();
  }
  console.log(failures === 0 ? "\nAll node checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
