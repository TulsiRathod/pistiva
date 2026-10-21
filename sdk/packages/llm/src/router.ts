import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { PromptLibrary } from "./prompts.ts";
import { LlmError, type LlmProvider, type LlmUsage } from "./types.ts";

export interface LlmRouterOptions {
  provider: LlmProvider;
  prompts?: PromptLibrary;
  /** Every call's token usage, for metering and cost reports. */
  onUsage?(usage: LlmUsage): void | Promise<void>;
}

/**
 * The single way agent modules reach a model: render a versioned prompt, call the organization's
 * provider, and accept the answer only if it parses and validates against the expected schema.
 * One repair attempt is made with the validation errors; after that the caller falls back.
 */
export class LlmRouter {
  readonly prompts: PromptLibrary;
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false });
  private readonly validators = new WeakMap<object, ValidateFunction>();

  constructor(private readonly opts: LlmRouterOptions) {
    this.prompts = opts.prompts ?? new PromptLibrary();
  }

  get providerName(): string {
    return this.opts.provider.name;
  }

  async json<T>(promptName: string, vars: Record<string, string>, schema: Record<string, unknown>): Promise<T> {
    const { prompt, system, user } = this.prompts.render(promptName, vars);
    let validate = this.validators.get(schema);
    if (!validate) {
      validate = this.ajv.compile(schema);
      this.validators.set(schema, validate);
    }

    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.opts.provider.complete({
        system,
        user: attempt === 0 ? user : `${user}\n\nYour previous answer was rejected: ${lastError}\nAnswer again with JSON that matches the schema exactly.`,
        schema,
        effort: prompt.effort,
        promptId: prompt.id,
        maxTokens: 4000,
      });
      await this.opts.onUsage?.(res.usage);
      let parsed: unknown;
      try {
        parsed = JSON.parse(extractJson(res.text));
      } catch {
        lastError = "the answer was not valid JSON";
        continue;
      }
      if (validate(parsed)) return parsed as T;
      lastError = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    }
    throw new LlmError("invalid_output", `${prompt.id} produced no valid answer: ${lastError}`);
  }
}

/** Tolerates a fenced code block around the JSON, which some local models add despite the schema. */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return (fenced ? fenced[1]! : text).trim();
}
