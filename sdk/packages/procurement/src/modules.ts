import { randomBytes } from "node:crypto";
import { fromMinor, scaleBps, toMinor } from "@pistiva/agent-sdk";
import type { CapabilityHandler, HandlerOutcome } from "@pistiva/gateway";
import type { InventoryConnector, InventoryItem } from "./inventory.ts";

/** quote.request@1 request, as defined by the procurement domain pack. */
export interface QuoteRequest {
  sku: string;
  qty: number;
  uom?: string;
  deliverBy?: string;
  incoterm?: string;
  specs?: string;
}

/** Default disclosure for quote.request@1: everything in its result schema except nothing private. */
export const QUOTE_RESPONSE_FIELDS = ["sku", "available", "qty", "uom", "unitPrice", "currency", "validUntil", "leadTimeDays", "paymentTerms", "terms"];

export interface QuoteOptions {
  /** Price multiplier in basis points (10000 = list price). */
  priceFactorBps?: number;
  currency?: string;
  standardLeadDays?: number;
  backorderLeadDays?: number;
  paymentTerms?: string;
  quoteValidDays?: number;
}

function isoDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * quote.request@1 against the business's own inventory. When stock cannot cover the quantity it asks
 * one clarifying question (partial delivery or backorder) instead of guessing. The handler sees the
 * full private record; the gateway discloses only the allowlist ∩ the grant.
 */
export function quoteCapability(inventory: InventoryConnector, options: QuoteOptions = {}): CapabilityHandler<QuoteRequest> {
  const o = { priceFactorBps: 10_000, currency: "INR", standardLeadDays: 5, backorderLeadDays: 14, paymentTerms: "NET30", quoteValidDays: 7, ...options };

  function quote(item: InventoryItem, qty: number, leadTimeDays: number): HandlerOutcome {
    // Return the whole record on purpose: the gateway's allowlist is what protects private fields.
    return {
      state: "completed",
      result: {
        ...item,
        available: true,
        qty,
        uom: "EA",
        unitPrice: scaleBps(item.listPrice, o.priceFactorBps),
        currency: o.currency,
        validUntil: isoDate(o.quoteValidDays),
        leadTimeDays,
        paymentTerms: o.paymentTerms,
        terms: leadTimeDays > o.standardLeadDays ? `Backorder, ships in ${leadTimeDays} days` : `Delivery in ${leadTimeDays} working days`,
      },
    };
  }

  return {
    responseFields: QUOTE_RESPONSE_FIELDS,
    validate(body) {
      const uom = (body as QuoteRequest).uom;
      return uom && uom !== "EA" ? "This supplier quotes in EA only" : null;
    },
    async start({ sku, qty }, ctx) {
      const item = await inventory.find(sku);
      if (!item) return { state: "completed", result: { sku, available: false, terms: "SKU not stocked" } };
      if (item.stockOnHand >= qty) return quote(item, qty, o.standardLeadDays);
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
    async resume({ answer }, ctx) {
      const pending = ctx.memory.pending as { sku: string; qty: number } | undefined;
      const item = pending && (await inventory.find(pending.sku));
      if (!pending || !item) return { state: "failed", reason: "No pending quote for this task" };
      if (answer === "partial") return quote(item, item.stockOnHand, o.standardLeadDays);
      if (answer === "backorder") return quote(item, pending.qty, o.backorderLeadDays);
      return { state: "input-required", clarification: { question: "Please answer partial or backorder.", field: "qty", options: ["partial", "backorder"] } };
    },
  };
}

export interface DraftOrder {
  orderRef: string;
  quoteTaskId: string;
  requesterAgentId: string;
  sku: string;
  qty: number;
  unitPrice: string;
  currency: string;
  total: string;
  holdUntil: string;
  status: "draft" | "confirmed" | "rejected";
}

/** Where a supplier keeps the drafts it holds; order.confirm (M2.3) reads them back. */
export interface DraftStore {
  save(draft: DraftOrder): Promise<void>;
  get(orderRef: string): Promise<DraftOrder | undefined>;
}

export class MemoryDraftStore implements DraftStore {
  private readonly drafts = new Map<string, DraftOrder>();

  async save(draft: DraftOrder) {
    this.drafts.set(draft.orderRef, { ...draft });
  }

  async get(orderRef: string) {
    const d = this.drafts.get(orderRef);
    return d && { ...d };
  }
}

/** order.draft@1: holds a draft order. A draft is not a commitment; order.confirm (with approval) is. */
export function orderDraftCapability(store: DraftStore = new MemoryDraftStore(), holdDays = 3) {
  const handler: CapabilityHandler<{ quoteTaskId: string; sku: string; qty: number; unitPrice: string; currency: string }> = {
    async handle({ quoteTaskId, sku, qty, unitPrice, currency }, ctx) {
      const draft: DraftOrder = {
        orderRef: `DRAFT-${randomBytes(4).toString("hex").toUpperCase()}`,
        quoteTaskId,
        requesterAgentId: ctx.requesterAgentId,
        sku,
        qty,
        unitPrice,
        currency,
        total: fromMinor(toMinor(unitPrice) * BigInt(qty)),
        holdUntil: isoDate(holdDays),
        status: "draft",
      };
      await store.save(draft);
      return { orderRef: draft.orderRef, status: "draft", total: draft.total, currency, holdUntil: draft.holdUntil };
    },
  };
  return handler;
}
