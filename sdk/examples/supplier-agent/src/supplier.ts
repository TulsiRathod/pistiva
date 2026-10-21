import { PlatformClient, type AgentCard, type AgentKeyPair } from "@pistiva/agent-sdk";
import { createProviderGateway } from "@pistiva/gateway";
import { ArrayInventory, MemoryDraftStore, orderConfirmCapability, orderDraftCapability, QUOTE_RESPONSE_FIELDS, quoteCapability, type InventoryItem } from "@pistiva/procurement";
import type { FastifyInstance } from "fastify";

export { QUOTE_RESPONSE_FIELDS, type InventoryItem } from "@pistiva/procurement";
export interface SupplierConfig {
  platformUrl: string;
  agentId: string;
  orgId: string;
  kid: string;
  keys: AgentKeyPair;
  name: string;
  publicUrl: string;
  port: number;
  host?: string;
  inventory: InventoryItem[];
  priceFactorBps?: number;
  auditLogPath?: string;
}

/** Publishes the signed agent card, then serves tasks (A2A and legacy) on the supplier's own infrastructure. */
export async function startSupplier(cfg: SupplierConfig): Promise<{ app: FastifyInstance; platform: PlatformClient }> {
  const platform = new PlatformClient({ baseUrl: cfg.platformUrl, agentId: cfg.agentId, kid: cfg.kid, keys: cfg.keys, statusTtlMs: 5_000 });
  const card: AgentCard = {
    agentId: cfg.agentId,
    orgId: cfg.orgId,
    kid: cfg.kid,
    name: cfg.name,
    version: "0.2.0",
    endpoint: cfg.publicUrl,
    protocols: ["a2a/0.3", "pistiva-envelope/1"],
    capabilities: [
      {
        name: "quote.request",
        version: 1,
        description: "Availability, unit price and terms for a SKU and quantity",
        price: { model: "per_task", amount: "2.00", currency: "INR" },
        responseFields: QUOTE_RESPONSE_FIELDS,
      },
      {
        name: "order.draft",
        version: 1,
        description: "Hold a draft order against an accepted quote",
        price: { model: "per_task", amount: "0.00", currency: "INR" },
      },
      {
        name: "order.confirm",
        version: 1,
        description: "Commit a held draft order",
        price: { model: "per_task", amount: "0.00", currency: "INR" },
      },
    ],
    issuedAt: Math.floor(Date.now() / 1000),
  };
  await platform.publishCard(card);
  // Drafts and confirmations share one store, so a confirm finds the draft it commits.
  const drafts = new MemoryDraftStore();
  const app = createProviderGateway({
    agentId: cfg.agentId,
    kid: cfg.kid,
    keys: cfg.keys,
    platform,
    card,
    description: `${cfg.name}: quotes and draft orders from our own inventory`,
    capabilities: {
      "quote.request": quoteCapability(new ArrayInventory(cfg.inventory), { priceFactorBps: cfg.priceFactorBps }),
      "order.draft": orderDraftCapability(drafts),
      "order.confirm": orderConfirmCapability(drafts),
    },
    auditLogPath: cfg.auditLogPath,
  });
  await app.listen({ port: cfg.port, host: cfg.host ?? "0.0.0.0" });
  return { app, platform };
}
