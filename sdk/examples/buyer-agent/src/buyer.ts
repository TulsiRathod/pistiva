import {
  A2AClient,
  fromMinor,
  toMinor,
  type A2AOutcome,
  type AgentKeyPair,
  type Clarification,
  type DiscoveredAgent,
  type PlatformClient,
} from "@pistiva/agent-sdk";

/** quote.request@1 result, as defined by the procurement domain pack. */
export interface Quote {
  sku: string;
  available: boolean;
  qty?: number;
  uom?: string;
  unitPrice?: string;
  currency?: string;
  validUntil?: string;
  leadTimeDays?: number;
  paymentTerms?: string;
  terms?: string;
}

/** order.draft@1 result. */
export interface DraftOrder {
  orderRef: string;
  status: "draft";
  total: string;
  currency: string;
  holdUntil?: string;
}

export interface QuoteResult {
  supplier: DiscoveredAgent;
  outcome?: A2AOutcome<Quote>;
  /** Questions the supplier asked and the answers given. */
  clarifications: { question: string; answer: string }[];
  error?: string;
}

export interface ProcurementDecision {
  quotes: QuoteResult[];
  selected?: { supplier: DiscoveredAgent; quote: Quote; total: string; taskId: string };
  draft?: A2AOutcome<DraftOrder>;
  /**
   * This agent never commits a purchase. It holds a draft order and either marks it ready for the
   * order step or flags it for the human approval the policy demands.
   */
  status: "requires_approval" | "draft_held" | "no_eligible_offer";
  reason: string;
}

/**
 * Deterministic default for supplier questions: a full backorder beats a partial delivery. An LLM
 * module can replace this later; whatever answers, the contract schema still bounds the reply.
 */
export const preferFullQuantity = (c: Clarification) =>
  c.options?.includes("backorder") ? { answer: "backorder" } : c.options?.[0] ? { answer: c.options[0] } : null;

/**
 * Procurement flow from the team document's happy path, over A2A: discover suppliers, request a
 * quote from each with only the SKU and quantity, answer clarifying questions, compare, and hold a
 * draft order with the cheapest full-quantity offer.
 */
export async function requestQuotes(opts: {
  platform: PlatformClient;
  keys: AgentKeyPair;
  sku: string;
  qty: number;
  budget: string;
  currency: string;
  /** Restricts which discovered suppliers are asked, e.g. an approved-vendor list. */
  acceptSupplier?: (supplier: DiscoveredAgent) => boolean;
  answerClarification?: (c: Clarification) => { answer: string } | null;
}): Promise<ProcurementDecision> {
  const suppliers = (await opts.platform.discover("quote.request")).filter(opts.acceptSupplier ?? (() => true));
  const client = new A2AClient({ platform: opts.platform, keys: opts.keys });
  const answer = opts.answerClarification ?? preferFullQuantity;
  const spend = { budget: opts.budget, currency: opts.currency };

  const quotes: QuoteResult[] = await Promise.all(
    suppliers.map(async (supplier) => {
      const clarifications: QuoteResult["clarifications"] = [];
      try {
        const outcome = await client.run<{ sku: string; qty: number }, Quote>(supplier, "quote.request", { sku: opts.sku, qty: opts.qty }, spend, (c) => {
          const a = answer(c);
          if (a) clarifications.push({ question: c.question, answer: a.answer });
          return a;
        });
        return { supplier, outcome, clarifications };
      } catch (e) {
        return { supplier, clarifications, error: (e as Error).message };
      }
    }),
  );

  const budget = toMinor(opts.budget);
  const eligible = quotes
    .filter((q) => {
      const r = q.outcome?.result;
      return q.outcome?.state === "completed" && r?.available && r.unitPrice && r.currency === opts.currency && (r.qty ?? opts.qty) >= opts.qty;
    })
    .map((q) => ({ q, total: toMinor(q.outcome!.result!.unitPrice!) * BigInt(opts.qty) }))
    .filter(({ total }) => total <= budget)
    .sort((a, b) => (a.total < b.total ? -1 : a.total > b.total ? 1 : 0));

  const best = eligible[0];
  if (!best) return { quotes, status: "no_eligible_offer", reason: "No supplier offered the full quantity within budget" };
  const quote = best.q.outcome!.result!;
  const selected = { supplier: best.q.supplier, quote, total: fromMinor(best.total), taskId: best.q.outcome!.taskId };

  const draft = await client.run<Record<string, unknown>, DraftOrder>(
    best.q.supplier,
    "order.draft",
    { quoteTaskId: selected.taskId, sku: opts.sku, qty: opts.qty, unitPrice: quote.unitPrice!, currency: opts.currency },
    spend,
  );
  if (draft.state !== "completed") {
    return { quotes, selected, draft, status: "no_eligible_offer", reason: `Supplier would not hold a draft: ${draft.reason ?? draft.state}` };
  }
  if (best.q.outcome!.approvalRequired || draft.approvalRequired) {
    return { quotes, selected, draft, status: "requires_approval", reason: "Budget is above the organization's approval threshold" };
  }
  return { quotes, selected, draft, status: "draft_held", reason: "Cheapest full-quantity offer within budget; draft held below the approval threshold" };
}
