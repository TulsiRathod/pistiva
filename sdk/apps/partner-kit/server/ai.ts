import type { ContractRegistry } from "@pistiva/agent-sdk";
import {
  CatalogIndex,
  checkSpecs,
  HashEmbedder,
  interpretRequest,
  LlmRouter,
  OllamaEmbedder,
  providerFromConfig,
  suggestClarificationAnswer,
  type Embedder,
  type InterpretedRequest,
  type LlmProvider,
  type LlmUsage,
  type ProviderConfig,
  type Suggestion,
} from "@pistiva/llm";
import type { InventoryConnector } from "@pistiva/procurement";
import type { Db } from "./db.ts";

/** agents.yaml `ai:` section. Everything is optional; without it the node runs on rules alone. */
export interface AiConfig {
  /** The model this organization uses: Claude API, a local Ollama model, or none. */
  llm?: ProviderConfig;
  /** Standing guidance for answer suggestions, e.g. "Prefer full quantity even with a longer lead time." */
  preferences?: string;
  /** Hybrid search over the node's own catalog. `hash` needs no model; `ollama` uses local embeddings. */
  rag?: { embedder?: "hash" | "ollama"; model?: string; dims?: number; baseUrl?: string };
  /** Ask the model whether a buyer's free-text specs fit our item before quoting (supplier side). */
  specCheck?: boolean;
}

/**
 * The node's AI layer. Models only ever draft (a request, a suggested answer) or raise a question
 * (did you mean, does this fit); operators and fixed rules make every decision.
 */
export class NodeAi {
  readonly router?: LlmRouter;
  readonly index?: CatalogIndex;

  constructor(
    private readonly cfg: AiConfig,
    private readonly deps: { db: Db; contracts: ContractRegistry; provider?: LlmProvider },
  ) {
    const provider = deps.provider ?? (cfg.llm ? providerFromConfig(cfg.llm) : undefined);
    if (provider) this.router = new LlmRouter({ provider, onUsage: (u) => this.recordUsage(u) });
    if (cfg.rag) this.index = new CatalogIndex(deps.db, buildEmbedder(cfg.rag));
  }

  get enabled(): { llm: string | null; rag: boolean; specCheck: boolean } {
    return { llm: this.router?.providerName ?? null, rag: !!this.index, specCheck: !!(this.router && this.cfg.specCheck) };
  }

  /** Indexes every connector that can list its items; returns how many items were indexed. */
  async reindex(connectors: Record<string, InventoryConnector>): Promise<number> {
    if (!this.index) return 0;
    let total = 0;
    const ids: string[] = [];
    for (const c of Object.values(connectors)) {
      if (!c.list) continue;
      const items = await c.list();
      const chunks = items.map((i) => ({
        id: `catalog:${i.sku}`,
        source: "catalog",
        ref: i.sku,
        // Public text only: never cost, stock, warehouse or notes.
        content: [i.name, i.sku, i.description ?? ""].filter(Boolean).join("\n"),
      }));
      total += await this.index.upsert(chunks);
      ids.push(...chunks.map((c) => c.id));
    }
    await this.index.prune("catalog", ids);
    return total;
  }

  /** Hooks for the supplier's quote module. */
  quoteHooks() {
    return {
      catalog: this.index ? (q: string) => this.index!.searchCatalog(q, 3) : undefined,
      specCheck: this.router && this.cfg.specCheck ? (item: { sku: string; name: string; description?: string }, specs: string) => checkSpecs(this.router!, item, specs) : undefined,
    };
  }

  /** Buyer side: draft a quote.request from a description, for the operator to review before sending. */
  async interpret(text: string): Promise<InterpretedRequest> {
    if (!this.router) throw new Error("No language model is configured for this node (ai.llm in agents.yaml)");
    const catalog = this.index ? await this.index.searchCatalog(text, 5) : [];
    return interpretRequest(this.router, text, {
      catalog,
      validate: (request) => this.deps.contracts.validate("quote.request", 1, "request", request),
    });
  }

  /** Buyer side: a suggested answer to a supplier's question; undefined when there's nothing reliable to suggest. */
  async suggest(input: { request: Record<string, unknown>; question: string; options?: string[] }): Promise<Suggestion | undefined> {
    if (!this.router) return undefined;
    return suggestClarificationAnswer(this.router, { ...input, preferences: this.cfg.preferences }).catch(() => undefined);
  }

  async usage(): Promise<{ promptId: string; provider: string; model: string; calls: number; inputTokens: number; outputTokens: number }[]> {
    const { rows } = await this.deps.db.query(
      `SELECT prompt_id, provider, model, count(*)::int AS calls, sum(input_tokens)::int AS input_tokens, sum(output_tokens)::int AS output_tokens
       FROM kit_llm_usage GROUP BY prompt_id, provider, model ORDER BY calls DESC`,
    );
    return rows.map((r) => ({ promptId: r.prompt_id, provider: r.provider, model: r.model, calls: r.calls, inputTokens: r.input_tokens, outputTokens: r.output_tokens }));
  }

  private async recordUsage(u: LlmUsage): Promise<void> {
    await this.deps.db.query(
      "INSERT INTO kit_llm_usage (provider, model, prompt_id, input_tokens, output_tokens, latency_ms) VALUES ($1, $2, $3, $4, $5, $6)",
      [u.provider, u.model, u.promptId ?? null, u.inputTokens, u.outputTokens, u.latencyMs],
    );
  }
}

function buildEmbedder(rag: NonNullable<AiConfig["rag"]>): Embedder {
  return rag.embedder === "ollama" ? new OllamaEmbedder(rag.dims ?? 768, rag.model ?? "nomic-embed-text", rag.baseUrl) : new HashEmbedder(rag.dims ?? 256);
}
