import { randomBytes } from "node:crypto";
import { fromMinor, PlatformClient, scaleBps, toMinor, type AgentCard, type AgentKeyPair } from "@pistiva/agent-sdk";
import { createProviderGateway, type CapabilityHandler, type HandlerOutcome } from "@pistiva/gateway";
import type { FastifyInstance } from "fastify";

export interface InventoryItem {
  sku: string;
  name: string;
  stockOnHand: number;
  listPrice: string;
  costPrice: string;
  warehouse: string;
  supplierNotes: string;
}

/** quote.request@1 request, as defined by the procurement domain pack. */
export interface QuoteRequest {
  sku: string;
  qty: number;
  uom?: string;
  deliverBy?: string;
  incoterm?: string;
  specs?: string;
}

/** What this supplier chooses to disclose from quote.request@1's result schema. */
export const QUOTE_RESPONSE_FIELDS = ["sku", "available", "qty", "uom", "unitPrice", "currency", "validUntil", "leadTimeDays", "paymentTerms", "terms"];

const BACKORDER_LEAD_DAYS = 14;

function isoDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Quotes from the supplier's own inventory, locally. When stock cannot cover the quantity it asks
 * one clarifying question (partial delivery or backorder) instead of guessing. The handler sees the
 * full private record; the gateway discloses only QUOTE_RESPONSE_FIELDS ∩ the grant.
 */
export function quoteCapability(inventory: InventoryItem[], priceFactorBps = 10_000): CapabilityHandler<QuoteRequest> {
  function quote(item: InventoryItem, qty: number, leadTimeDays: number): HandlerOutcome {
    // Return the whole record on purpose: the gateway's allowlist is what protects private fields.
    return {
      state: "completed",
      result: {
        ...item,
        available: true,
        qty,
        uom: "EA",
        unitPrice: scaleBps(item.listPrice, priceFactorBps),
        currency: "INR",
        validUntil: isoDate(7),
        leadTimeDays,
        paymentTerms: "NET30",
        terms: leadTimeDays > 5 ? `Backorder, ships in ${leadTimeDays} days` : "Delivery in 5 working days",
      },
    };
  }

  return {
    responseFields: QUOTE_RESPONSE_FIELDS,
    validate(body) {
      const uom = (body as QuoteRequest).uom;
      return uom && uom !== "EA" ? "This supplier quotes in EA only" : null;
    },
    start({ sku, qty }, ctx) {
      const item = inventory.find((i) => i.sku === sku);
      if (!item) return { state: "completed", result: { sku, available: false, terms: "SKU not stocked" } };
      if (item.stockOnHand >= qty) return quote(item, qty, 5);
      ctx.memory.pending = { sku, qty };
      // Yes/no on stock rather than the stock count, so repeated quotes reveal less about inventory.
      return {
        state: "input-required",
        clarification: {
          question: `We cannot ship ${qty} units of ${sku} from stock. Accept a partial quantity now, or backorder the full quantity?`,
          field: "qty",
          options: ["partial", "backorder"],
        },
      };
    },
    resume({ answer }, ctx) {
      const pending = ctx.memory.pending as { sku: string; qty: number } | undefined;
      const item = pending && inventory.find((i) => i.sku === pending.sku);
      if (!pending || !item) return { state: "failed", reason: "No pending quote for this task" };
      if (answer === "partial") return quote(item, item.stockOnHand, 5);
      if (answer === "backorder") return quote(item, pending.qty, BACKORDER_LEAD_DAYS);
      return { state: "input-required", clarification: { question: "Please answer partial or backorder.", field: "qty", options: ["partial", "backorder"] } };
    },
  };
}

/** order.draft@1: holds a draft order. A draft is not a commitment; order.confirm (with approval) is. */
export function orderDraftCapability(): CapabilityHandler<{ sku: string; qty: number; unitPrice: string; currency: string }> {
  return {
    handle({ qty, unitPrice, currency }) {
      return {
        orderRef: `DRAFT-${randomBytes(4).toString("hex").toUpperCase()}`,
        status: "draft",
        total: fromMinor(toMinor(unitPrice) * BigInt(qty)),
        currency,
        holdUntil: isoDate(3),
      };
    },
  };
}

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
    ],
    issuedAt: Math.floor(Date.now() / 1000),
  };
  await platform.publishCard(card);
  const app = createProviderGateway({
    agentId: cfg.agentId,
    kid: cfg.kid,
    keys: cfg.keys,
    platform,
    card,
    description: `${cfg.name}: quotes and draft orders from our own inventory`,
    capabilities: {
      "quote.request": quoteCapability(cfg.inventory, cfg.priceFactorBps),
      "order.draft": orderDraftCapability(),
    },
    auditLogPath: cfg.auditLogPath,
  });
  await app.listen({ port: cfg.port, host: cfg.host ?? "0.0.0.0" });
  return { app, platform };
}
