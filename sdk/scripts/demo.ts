/**
 * End-to-end demo against a running platform, over A2A with the pistiva-trust extension:
 *   1. bootstrap a buyer org and two supplier orgs (registered, verified, agents, keys)
 *   2. start both supplier gateways and publish their signed cards
 *   3. quote flow: discover -> grant -> signed A2A message -> verified reply -> countersigned receipt -> draft order
 *   4. multi-turn flow: supplier asks a clarifying question, buyer answers, every round is receipted
 *   5. negative paths: over-budget grant denied, revoked key cannot start a task
 * Exits non-zero if any check fails.
 */
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AGENT_CARD_PATH, PISTIVA_TRUST_EXTENSION, PlatformClient, PlatformError, type A2AAgentCard } from "@pistiva/agent-sdk";
import { requestQuotes } from "@pistiva/example-buyer-agent";
import { startSupplier, type InventoryItem } from "@pistiva/example-supplier-agent";
import { api, Bootstrapper, PLATFORM_URL, waitForPlatform } from "./lib/bootstrap.ts";

const SUPPLIER_HOST = process.env.SUPPLIER_HOST ?? "localhost";
const boot = new Bootstrapper();
const RUN = boot.run;
const KEY_DIR = boot.keyDir;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function main() {
  console.log(`Platform: ${PLATFORM_URL}   run: ${RUN}   keys: ${KEY_DIR}\n`);
  await waitForPlatform();

  console.log("1. Bootstrapping organizations and agents");
  const buyer = await boot.org("acme", "Acme Manufacturing", "http://localhost:9100");
  const s1 = await boot.org("bharat", "Bharat Fasteners", `http://${SUPPLIER_HOST}:9101`);
  const s2 = await boot.org("deccan", "Deccan Industrial Supply", `http://${SUPPLIER_HOST}:9102`);

  console.log("2. Starting supplier gateways");
  const inventory = JSON.parse(
    await readFile(fileURLToPath(new URL("../examples/supplier-agent/data/inventory.json", import.meta.url)), "utf8"),
  ) as InventoryItem[];
  const gateways = await Promise.all(
    [
      { s: s1, port: 9101, factor: 10_000 },
      { s: s2, port: 9102, factor: 9_500 },
    ].map(({ s, port, factor }) =>
      startSupplier({
        platformUrl: PLATFORM_URL,
        agentId: s.agentId,
        orgId: s.orgId,
        kid: s.kid,
        keys: s.keys,
        name: `${s.orgName} quote agent`,
        publicUrl: `http://${SUPPLIER_HOST}:${port}`,
        port,
        inventory,
        priceFactorBps: factor,
        auditLogPath: join(KEY_DIR, `${s.orgName.split(" ")[0]!.toLowerCase()}-audit.jsonl`),
      }),
    ),
  );

  try {
    const platform = new PlatformClient({ baseUrl: PLATFORM_URL, agentId: buyer.agentId, kid: buyer.kid, keys: buyer.keys, statusTtlMs: 0 });
    // Ignore suppliers left over from earlier demo runs.
    const approvedVendors = (d: { agentId: string }) => [s1.agentId, s2.agentId].includes(d.agentId);

    const card = (await (await fetch(`http://localhost:9101${AGENT_CARD_PATH}`)).json()) as A2AAgentCard;
    check("supplier serves an A2A agent card requiring pistiva-trust", card.capabilities.extensions.some((e) => e.uri === PISTIVA_TRUST_EXTENSION && e.required),
      card.skills.map((s) => s.id).join(", "));

    console.log("\n3. Buyer requests quotes for 500 x BOLT-M8-50 over A2A (budget 5000.00 INR)");
    const decision = await requestQuotes({ platform, keys: buyer.keys, sku: "BOLT-M8-50", qty: 500, budget: "5000.00", currency: "INR", acceptSupplier: approvedVendors });
    const ours = decision.quotes;
    for (const q of ours) {
      console.log(`     ${q.supplier.orgName.padEnd(26)} ${q.outcome ? JSON.stringify(q.outcome.result) : `error: ${q.error}`}`);
    }
    check("discovery found both verified suppliers", ours.length === 2);
    check("both quotes completed in one round over a direct connection", ours.every((q) => q.outcome?.state === "completed" && q.outcome.rounds.length === 1 && q.outcome.connection === "direct"));
    check(
      "no private inventory fields were disclosed",
      ours.every((q) => q.outcome?.result && !["costPrice", "warehouse", "supplierNotes", "stockOnHand"].some((f) => f in q.outcome!.result!)),
    );
    check("countersigned receipts recorded on the platform", ours.every((q) => q.outcome?.rounds.every((r) => r.recorded)));
    check("cheapest supplier selected", decision.selected?.supplier.agentId === s2.agentId, `${decision.selected?.supplier.orgName} total ${decision.selected?.total}`);
    check("draft order held below the approval threshold", decision.status === "draft_held" && !!decision.draft?.result?.orderRef,
      `${decision.draft?.result?.orderRef} ${decision.draft?.result?.total} ${decision.draft?.result?.currency}`);

    console.log("\n4. Buyer asks for 40000 x NUT-M8, more than either supplier stocks (budget 45000.00 INR)");
    const big = await requestQuotes({ platform, keys: buyer.keys, sku: "NUT-M8", qty: 40000, budget: "45000.00", currency: "INR", acceptSupplier: approvedVendors });
    for (const q of big.quotes) {
      for (const c of q.clarifications) console.log(`     ${q.supplier.orgName.padEnd(26)} asked: "${c.question}" -> ${c.answer}`);
    }
    check("each supplier asked a clarifying question", big.quotes.every((q) => q.clarifications.length === 1));
    check("each quote took two rounds, both receipted", big.quotes.every((q) => q.outcome?.rounds.map((r) => r.state).join(",") === "input-required,completed" && q.outcome.rounds.every((r) => r.recorded)));
    check("backorder quote covers the full quantity", big.selected?.quote.qty === 40000 && big.selected.quote.leadTimeDays === 14, big.selected?.quote.terms);
    check("above approval threshold: human approval required", big.status === "requires_approval", big.reason);

    console.log("\n5. Policy and revocation checks");    const denied = await platform.requestGrant({ providerAgentId: s1.agentId, capability: "quote.request", budget: "999999.00", currency: "INR" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    check("over-budget grant denied by policy", denied instanceof PlatformError && denied.code === "policy_denied", (denied as Error | undefined)?.message);

    const audit = await api<{ type: string }[]>("GET", `/audit?orgId=${buyer.orgId}`, buyer.userToken);
    check("denial is in the buyer's audit log", audit.some((e) => e.type === "GRANT_DENIED"));
    check("per-round receipts are in the audit log", audit.filter((e) => e.type === "RECEIPT_RECORDED").length >= 8);

    await api("DELETE", `/agents/${buyer.agentId}/keys/${buyer.kid}`, buyer.userToken);
    const afterRevoke = await requestQuotes({ platform, keys: buyer.keys, sku: "BOLT-M8-50", qty: 10, budget: "100.00", currency: "INR", acceptSupplier: approvedVendors }).then(
      () => "succeeded",
      (e: unknown) => (e instanceof PlatformError ? `${e.status} ${e.message}` : String(e)),
    );
    check("revoked key cannot start new tasks", afterRevoke !== "succeeded", afterRevoke);
  } finally {
    await Promise.all(gateways.map((g) => g.app.close()));
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
