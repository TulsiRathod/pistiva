/** A model call as the agent modules see it: one system prompt, one user turn, optional JSON schema. */
export interface LlmRequest {
  system: string;
  user: string;
  /** When set, the provider constrains output to this JSON schema and the router validates it again. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
  /** How hard to think. Routine extraction runs at low effort; judgement calls higher. */
  effort?: "low" | "medium" | "high";
  /** Prompt name and version, for usage records and evals. */
  promptId?: string;
}

export interface LlmUsage {
  provider: string;
  model: string;
  promptId?: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
}

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** The model declined or its output did not meet the contract; callers fall back to deterministic behaviour. */
export class LlmError extends Error {
  constructor(
    readonly code: "refusal" | "invalid_output" | "provider_error" | "truncated",
    message: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
