import Anthropic from "@anthropic-ai/sdk";
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from "./types.ts";

export interface AnthropicOptions {
  /** Defaults to the SDK's own credential resolution (ANTHROPIC_API_KEY, `ant auth login` profile, ...). */
  apiKey?: string;
  model?: string;
  /** Let the API re-run a refused request on a fallback model it chooses (server-side fallback). */
  serverFallback?: boolean;
  client?: Anthropic;
}

/**
 * Claude via the official SDK. Structured output uses `output_config.format`; thinking is
 * adaptive and depth is set per call with `output_config.effort`.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly serverFallback: boolean;

  constructor(opts: AnthropicOptions = {}) {
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = opts.model ?? "claude-opus-5-5";
    this.serverFallback = opts.serverFallback ?? true;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const params = {
      model: this.model,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      messages: [{ role: "user" as const, content: req.user }],
      output_config: {
        effort: req.effort ?? "low",
        ...(req.schema ? { format: { type: "json_schema" as const, schema: req.schema } } : {}),
      },
    };
    let message;
    try {
      message = this.serverFallback
        ? await this.client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
        : await this.client.messages.create(params);
    } catch (e) {
      if (e instanceof Anthropic.APIError) throw new LlmError("provider_error", `Claude API error ${e.status}: ${e.message}`);
      throw e;
    }
    if (message.stop_reason === "refusal") throw new LlmError("refusal", "The model declined this request");
    if (message.stop_reason === "max_tokens") throw new LlmError("truncated", "The model's answer was cut off");
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return {
      text,
      usage: {
        provider: this.name,
        model: message.model,
        promptId: req.promptId,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        latencyMs: Date.now() - started,
      },
    };
  }
}

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
}

/** A local model through Ollama, for businesses that keep every prompt on their own machines. */
export class OllamaProvider implements LlmProvider {
  readonly name = "ollama";
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(opts: OllamaOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
    this.model = opts.model ?? "qwen2.5:7b-instruct";
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        // Ollama constrains generation to a JSON schema when one is given.
        ...(req.schema ? { format: req.schema } : {}),
        options: { temperature: 0, num_predict: req.maxTokens ?? 2048 },
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
    }).catch((e: Error) => {
      throw new LlmError("provider_error", `Ollama unreachable at ${this.baseUrl}: ${e.message}`);
    });
    if (!res.ok) throw new LlmError("provider_error", `Ollama error ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; done_reason?: string };
    if (body.done_reason === "length") throw new LlmError("truncated", "The model's answer was cut off");
    return {
      text: body.message?.content ?? "",
      usage: {
        provider: this.name,
        model: this.model,
        promptId: req.promptId,
        inputTokens: body.prompt_eval_count ?? 0,
        outputTokens: body.eval_count ?? 0,
        latencyMs: Date.now() - started,
      },
    };
  }
}

/** Deterministic provider for tests and offline demos: a function decides each answer. */
export class ScriptedProvider implements LlmProvider {
  readonly name = "scripted";
  readonly calls: LlmRequest[] = [];

  constructor(private readonly respond: (req: LlmRequest) => string | Record<string, unknown>) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const out = this.respond(req);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    return { text, usage: { provider: this.name, model: "scripted", promptId: req.promptId, inputTokens: 0, outputTokens: 0, latencyMs: 0 } };
  }
}

export type ProviderConfig =
  | { provider: "anthropic"; model?: string; apiKey?: string; serverFallback?: boolean }
  | { provider: "ollama"; model?: string; baseUrl?: string }
  | { provider: "none" };

/** Builds the provider an organization chose in its configuration. */
export function providerFromConfig(cfg: ProviderConfig): LlmProvider | undefined {
  switch (cfg.provider) {
    case "anthropic":
      return new AnthropicProvider({ model: cfg.model, apiKey: cfg.apiKey, serverFallback: cfg.serverFallback });
    case "ollama":
      return new OllamaProvider({ model: cfg.model, baseUrl: cfg.baseUrl });
    default:
      return undefined;
  }
}
