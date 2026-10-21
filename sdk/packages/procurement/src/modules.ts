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
  /** Optional: finds the closest catalog items for a SKU we don't stock (e.g. hybrid RAG search). */
  catalog?: (query: string) => Promise<{ sku: string; name: string }[]>;
  /** Optional: checks a buyer's free-text specs against our item's public description (e.g. an LLM). */
  specCheck?: (item: { sku: string; name: string; description?: string }, specs: string) => Promise<{ matches: boolean; concern: string }>;
}

type Pending =
  | { kind: "stock"; sku: string; qty: number }
  | { kind: "alternative"; qty: number; specs?: string; options: string[] }
  | { kind: "spec"; sku: string; qty: number };

function isoDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * quote.request@1 against the business's own inventory. It asks a clarifying question instead of
 * guessing when: stock can't cover the quantity (partial or backorder), the SKU isn't stocked but
 * similar items are (did you mean ...), or the buyer's specs conflict with our item (quote as is?).
 * The handler sees the full private record; the gateway discloses only the allowlist ∩ the grant.
 * Optional AI hooks only ever lead to a question; every quote is computed by these rules.
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

  function stockCheck(item: InventoryItem, qty: number, memory: Record<string, unknown>): HandlerOutcome {
    if (item.stockOnHand >= qty) return quote(item, qty, o.standardLeadDays);
    memory.pending = { kind: "stock", sku: item.sku, qty } satisfies Pending;
    // Yes/no on stock rather than the stock count, so repeated quotes reveal less about inventory.
    return {
      state: "input-required",
      clarification: {
        question: `We cannot ship ${qty} units of ${item.sku} from stock. Accept a partial quantity now, or backorder the full quantity?`,
        field: "qty",
        options: ["partial", "backorder"],
      },
    };
  }

  async function forItem(item: InventoryItem, qty: number, specs: string | undefined, memory: Record<string, unknown>): Promise<HandlerOutcome> {
    if (specs && o.specCheck && !memory.specAccepted) {
      const verdict = await o.specCheck({ sku: item.sku, name: item.name, description: item.description }, specs).catch(() => undefined);
      if (verdict && !verdict.matches) {
        memory.pending = { kind: "spec", sku: item.sku, qty } satisfies Pending;
        return {
          state: "input-required",
          clarification: {
            question: `Our ${item.sku} is "${item.name}". ${verdict.concern || "It may not meet your specification."} Should we quote it as is?`.slice(0, 1000),
            field: "specs",
            options: ["quote as is", "cancel"],
          },
        };
      }
    }
    return stockCheck(item, qty, memory);
  }

  return {
    responseFields: QUOTE_RESPONSE_FIELDS,
    validate(body) {
      const uom = (body as QuoteRequest).uom;
      return uom && uom !== "EA" ? "This supplier quotes in EA only" : null;
    },
    async start({ sku, qty, specs }, ctx) {
      const item = await inventory.find(sku);
      if (item) return forItem(item, qty, specs, ctx.memory);
      const similar = o.catalog ? (await o.catalog(`${sku} ${specs ?? ""}`.trim()).catch(() => [])).filter((h) => h.sku !== sku).slice(0, 4) : [];
      if (!similar.length) return { state: "completed", result: { sku, available: false, terms: "SKU not stocked" } };
      ctx.memory.pending = { kind: "alternative", qty, specs, options: similar.map((h) => h.sku) } satisfies Pending;
      return {
        state: "input-required",
        clarification: {
          question: `We don't stock ${sku}. Did you mean one of these? ${similar.map((h) => `${h.sku} (${h.name})`).join("; ")}`.slice(0, 1000),
          field: "sku",
          options: [...similar.map((h) => h.sku), "none of these"],
        },
      };
    },
    async resume({ answer }, ctx) {
      const pending = ctx.memory.pending as Pending | undefined;
      if (!pending) return { state: "failed", reason: "No pending quote for this task" };
      if (pending.kind === "alternative") {
        if (!pending.options.includes(String(answer))) return { state: "completed", result: { sku: pending.options[0] ?? "", available: false, terms: "No matching item" } };
        const item = await inventory.find(String(answer));
        return item ? forItem(item, pending.qty, pending.specs, ctx.memory) : { state: "failed", reason: "Item no longer stocked" };
      }
      const item = await inventory.find(pending.sku);
      if (!item) return { state: "failed", reason: "Item no longer stocked" };
      if (pending.kind === "spec") {
        if (answer === "cancel") return { state: "rejected", reason: "The buyer declined the item as specified" };
        if (answer !== "quote as is") return { state: "input-required", clarification: { question: "Please answer quote as is or cancel.", field: "specs", options: ["quote as is", "cancel"] } };
        ctx.memory.specAccepted = true;
        return stockCheck(item, pending.qty, ctx.memory);
      }
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

/**
 * order.confirm@1: commits a held draft. Defence in depth on the provider side: the platform only
 * issues a commitment grant above the threshold against a human approval, and this handler also
 * refuses a grant that needed one but carries none, or that doesn't cover the draft's total.
 */
export function orderConfirmCapability(store: DraftStore, shipInDays = 5) {
  const handler: CapabilityHandler<{ orderRef: string; approvalId?: string }> = {
    async start({ orderRef }, ctx) {
      const draft = await store.get(orderRef);
      if (!draft || draft.requesterAgentId !== ctx.requesterAgentId) return { state: "rejected", reason: "No such draft order for this requester" };
      if (draft.status !== "draft") return { state: "rejected", reason: `Order is already ${draft.status}` };
      if (draft.holdUntil < new Date().toISOString().slice(0, 10)) return { state: "rejected", reason: "The draft's hold has expired; request a new quote" };
      if (ctx.grant.apr && !ctx.grant.apv) return { state: "rejected", reason: "This commitment requires a human approval on the buying side" };
      if (toMinor(ctx.grant.bud) < toMinor(draft.total) || ctx.grant.cur !== draft.currency) {
        return { state: "rejected", reason: `The grant covers ${ctx.grant.bud} ${ctx.grant.cur}; the order totals ${draft.total} ${draft.currency}` };
      }
      await store.save({ ...draft, status: "confirmed" });
      return { state: "completed", result: { orderRef, status: "confirmed", expectedShipDate: isoDate(shipInDays) } };
    },
  };
  return handler;
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
