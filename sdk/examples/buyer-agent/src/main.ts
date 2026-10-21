import { kidFor, loadKeyFile, PlatformClient } from "@pistiva/agent-sdk";
import { requestQuotes } from "./buyer.ts";

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const keys = await loadKeyFile(env("KEY_FILE"), env("KEY_PASSPHRASE"));
const platform = new PlatformClient({
  baseUrl: env("PLATFORM_URL", "http://localhost:8080"),
  agentId: env("AGENT_ID"),
  kid: kidFor(keys.publicKey),
  keys,
});

const decision = await requestQuotes({
  platform,
  keys,
  sku: env("SKU", "BOLT-M8-50"),
  qty: Number(env("QTY", "500")),
  budget: env("BUDGET", "5000.00"),
  currency: env("CURRENCY", "INR"),
});

for (const q of decision.quotes) {
  const line = q.outcome ? JSON.stringify(q.outcome.result) : `error: ${q.error}`;
  console.log(`${q.supplier.orgName.padEnd(28)} ${line}`);
}
console.log(`\nDecision: ${decision.status} — ${decision.reason}`);
if (decision.selected) console.log(`Selected ${decision.selected.supplier.orgName}, total ${decision.selected.total}`);
