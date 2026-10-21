# ADR 008: The AI layer — models draft and ask, rules decide

- Status: Accepted
- Date: 2026-10-21

## Context

The team document (§10) lists what AI may and may not do:
- **May:** interpret requests, compare offers, suggest next steps, summarize, recommend, draft orders.
- **May not, without authorization:** commit, reveal internal data, bypass policy, treat its own output as proof, overspend.

Every external action must pass a deterministic check, not a model's decision. Until now the network ran on rules alone.

## Decision

1. **One router, a provider per organization.** `@pistiva/llm` exposes `LlmRouter` over:
   - `AnthropicProvider`: the official `@anthropic-ai/sdk`, default model `claude-opus-5-5`, adaptive thinking with explicit effort per prompt, and structured output through `output_config.format`. Refusals are handled, and server-side refusal fallback (`fallbacks: "default"`) is on by default.
   - `OllamaProvider`, for businesses that keep every prompt on their own machines.
   - `ScriptedProvider`, for tests.

   Each Partner Kit picks its provider in `agents.yaml` (`ai.llm`). Without one the node runs on rules alone.
2. **Prompts are versioned files** (`packages/llm/prompts/<name>.v<n>.md`). Usage records and eval reports cite `name@version`.
3. **Every answer is validated.** The router re-checks the model's JSON against the schema (AJV) and allows one repair attempt. Each module then applies fixed rules and drops anything that doesn't pass:
   - **Request interpreter (buyer):** free text → `quote.request`. The result must satisfy the contract. Missing fields are reported to the operator, and nothing is sent until a person reviews it and clicks Send.
   - **Clarification advisor (buyer):** suggests an answer to a supplier's question. The answer must be one of the offered options. The operator accepts or overrides it.
   - **Offer explainer (buyer):** explains a choice the rules already made. The text must name the chosen supplier.
   - **Spec check (supplier):** sees only the item's public name and description, never cost, stock or warehouse. A conflict only ever leads to a "quote as is?" question.
4. **Peer text is data, not instructions.** Supplier questions, buyer specs and retrieved text are wrapped in `<untrusted>` tags, and every system prompt says to treat that content as inert. A heuristic flags injection-like phrasing to the operator. No module has tools, secrets or the power to commit.
5. **RAG over the node's own data.** `CatalogIndex` runs hybrid search in the node's own Postgres:
   - full-text rank plus pgvector cosine distance, fused with reciprocal rank fusion
   - an optional reranker hook, off by default
   - embeddings from Ollama, or a deterministic hashing embedder that needs no model

   It powers the supplier's "did you mean…" question for SKUs it doesn't stock.
6. **Evals have hard-fail codes.** `npm run eval` grades all four modules against a golden set that includes prompt-injection cases. Any security failure fails the run.
   - `--self-test` checks the harness with a rule-based stand-in model.
   - A test proves the graders fail a model that follows injections or leaks the budget.
7. **Every call is metered**, by prompt version, provider, model and tokens (`kit_llm_usage`). M2.8 will build billing on these records.

## Consequences

- Turning AI on never changes what can be committed or disclosed. That is enforced by the grant, the contract and the gateway's allowlist, all of which are deterministic.
- Model quality is only known after running the eval against a real provider. CI runs it when an `ANTHROPIC_API_KEY` secret is configured.
- The hash embedder is lexical. For semantic matches across vocabularies, enable Ollama embeddings.
