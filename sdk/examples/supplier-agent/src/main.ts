import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { kidFor, loadKeyFile } from "@pistiva/agent-sdk";
import { startSupplier, type InventoryItem } from "./supplier.ts";

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const keys = await loadKeyFile(env("KEY_FILE"), env("KEY_PASSPHRASE"));
const inventoryFile = env("INVENTORY_FILE", fileURLToPath(new URL("../data/inventory.json", import.meta.url)));
const inventory = JSON.parse(await readFile(inventoryFile, "utf8")) as InventoryItem[];
const port = Number(env("PORT", "9101"));

await startSupplier({
  platformUrl: env("PLATFORM_URL", "http://localhost:8080"),
  agentId: env("AGENT_ID"),
  orgId: env("ORG_ID"),
  kid: kidFor(keys.publicKey),
  keys,
  name: env("AGENT_NAME", "Supplier quote agent"),
  publicUrl: env("PUBLIC_URL", `http://localhost:${port}`),
  port,
  inventory,
  priceFactorBps: Number(env("PRICE_FACTOR_BPS", "10000")),
  auditLogPath: env("AUDIT_LOG", "./data/supplier-audit.jsonl"),
});
console.log(`Supplier agent listening on :${port}`);
