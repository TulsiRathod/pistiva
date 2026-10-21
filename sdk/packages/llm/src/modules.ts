import { looksLikeInjection, untrusted, UNTRUSTED_RULE } from "./guard.ts";
import type { LlmRouter } from "./router.ts";

/**
 * Agent modules: each makes one model call for one narrow job and checks the answer with fixed
 * rules before anyone uses it. None of them can commit, spend or disclose anything; those stay with
 * the deterministic policy in the platform and the gateways.
 */

const today = () => new Date().toISOString().slice(0, 10);
const UOMS = ["EA", "BOX", "PACK", "KG", "M", "L"];

export interface CatalogHit {
  sku: string;
  name: string;
  score?: number;
}

// ---------------------------------------------------------------------------------------------
// Buyer side: free text -> quote.request
// ---------------------------------------------------------------------------------------------

const INTERPRETER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sku", "qty", "uom", "deliverBy", "specs", "missing"],
  properties: {
    sku: { type: "string" },
    qty: { type: "integer" },
    uom: { type: "string", enum: ["", ...UOMS] },
    deliverBy: { type: "string" },
    specs: { type: "string" },
    missing: { type: "array", items: { type: "string", enum: ["sku", "qty"] } },
  },
} as const;

export interface InterpretedRequest {
  /** A quote.request@1 body, ready for the operator to review and send. */
  request: { sku: string; qty: number; uom?: string; deliverBy?: string; specs?: string };
  /** Fields the operator must fill in before the request can be sent. */
  missing: string[];
  promptId: string;
}

export async function interpretRequest(
  router: LlmRouter,
  text: string,
  opts: { catalog?: CatalogHit[]; validate?: (request: Record<string, unknown>) => Promise<void> } = {},
): Promise<InterpretedRequest> {
  const out = await router.json<{ sku: string; qty: number; uom: string; deliverBy: string; specs: string; missing: string[] }>(
    "request-interpreter",
    {
      today: today(),
      untrustedRule: UNTRUSTED_RULE,
      catalog: opts.catalog?.length ? opts.catalog.map((c) => `- ${c.sku}: ${c.name}`).join("\n") : "(none)",
      request: untrusted("buyer-operator", text),
    },
    INTERPRETER_SCHEMA as unknown as Record<string, unknown>,
  );
  const missing = new Set(out.missing);
  const sku = out.sku.trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(sku)) missing.add("sku");
  if (!Number.isSafeInteger(out.qty) || out.qty < 1) missing.add("qty");
  const request = {
    sku,
    qty: out.qty,
    ...(out.uom ? { uom: out.uom } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(out.deliverBy) ? { deliverBy: out.deliverBy } : {}),
    ...(out.specs.trim() ? { specs: out.specs.trim().slice(0, 2000) } : {}),
  };
  if (missing.size === 0 && opts.validate) await opts.validate(request);
  return { request, missing: [...missing], promptId: router.prompts.get("request-interpreter").id };
}

// ---------------------------------------------------------------------------------------------
// Buyer side: suggest an answer to a supplier's clarifying question
// ---------------------------------------------------------------------------------------------

const ADVISOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "rationale", "confidence"],
  properties: {
    answer: { type: "string" },
    rationale: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
} as const;

export interface Suggestion {
  answer: string;
  rationale: string;
  confidence: "low" | "medium" | "high";
  /** True when the question looked like it tried to steer the agent; shown to the operator. */
  suspicious: boolean;
  promptId: string;
}

/** Returns a suggestion for the operator to accept or override, or undefined when there is none worth showing. */
export async function suggestClarificationAnswer(
  router: LlmRouter,
  input: { request: Record<string, unknown>; question: string; options?: string[]; preferences?: string },
): Promise<Suggestion | undefined> {
  const suspicious = looksLikeInjection(input.question);
  const out = await router.json<{ answer: string; rationale: string; confidence: Suggestion["confidence"] }>(
    "clarification-advisor",
    {
      untrustedRule: UNTRUSTED_RULE,
      request: JSON.stringify(input.request),
      preferences: input.preferences?.trim() || "(none stated)",
      question: untrusted("supplier", input.question),
      options: input.options?.length ? input.options.map((o) => `- ${o}`).join("\n") : "(free answer)",
    },
    ADVISOR_SCHEMA as unknown as Record<string, unknown>,
  );
  const answer = out.answer.trim();
  // The supplier defined the valid answers; anything else is not a usable suggestion.
  if (input.options?.length && !input.options.includes(answer)) return undefined;
  if (!answer || answer.length > 1000) return undefined;
  return {
    answer,
    rationale: out.rationale.trim().slice(0, 600),
    confidence: suspicious ? "low" : out.confidence,
    suspicious,
    promptId: router.prompts.get("clarification-advisor").id,
  };
}

// ---------------------------------------------------------------------------------------------
// Buyer side: explain a deterministic choice between offers
// ---------------------------------------------------------------------------------------------

export interface QuoteForExplanation {
  supplier: string;
  quote?: Record<string, unknown>;
  outcome: string;
}

/** Explains a choice the rules already made. Returns undefined if the text doesn't name the chosen supplier. */
export async function explainChoice(
  router: LlmRouter,
  input: { request: Record<string, unknown>; budget: string; chosen: { supplier: string; total: string }; quotes: QuoteForExplanation[] },
): Promise<string | undefined> {
  const out = await router.json<{ explanation: string }>(
    "offer-explainer",
    {
      untrustedRule: UNTRUSTED_RULE,
      request: JSON.stringify(input.request),
      budget: input.budget,
      chosen: `${input.chosen.supplier}, total ${input.chosen.total}`,
      quotes: input.quotes.map((q) => untrusted(q.supplier, `${q.outcome}: ${JSON.stringify(q.quote ?? {})}`)).join("\n"),
    },
    { type: "object", additionalProperties: false, required: ["explanation"], properties: { explanation: { type: "string" } } },
  );
  const text = out.explanation.trim();
  return text && text.includes(input.chosen.supplier) ? text.slice(0, 1200) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Supplier side: does our item satisfy the buyer's free-text spec?
// ---------------------------------------------------------------------------------------------

export interface SpecVerdict {
  matches: boolean;
  concern: string;
}

/** The model sees only the item's public name/description, never stock, cost or warehouse. */
export async function checkSpecs(router: LlmRouter, item: { sku: string; name: string; description?: string }, specs: string): Promise<SpecVerdict> {
  const out = await router.json<SpecVerdict>(
    "spec-check",
    {
      untrustedRule: UNTRUSTED_RULE,
      item: `${item.sku}: ${item.name}${item.description ? ` — ${item.description}` : ""}`,
      specs: untrusted("buyer", specs),
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["matches", "concern"],
      properties: { matches: { type: "boolean" }, concern: { type: "string" } },
    },
  );
  return { matches: out.matches, concern: out.matches ? "" : out.concern.trim().slice(0, 300) };
}
