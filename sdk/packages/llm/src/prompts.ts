import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Prompts live as versioned files (prompts/<name>.v<version>.md), not in code, so a prompt change
 * is a reviewed diff with its own version that evals and usage records can refer to.
 *
 *   ---
 *   name: request-interpreter
 *   version: 1
 *   effort: low
 *   ---
 *   <system prompt>
 *   === user ===
 *   <user template with {{variables}}>
 */
export interface Prompt {
  name: string;
  version: number;
  effort: "low" | "medium" | "high";
  system: string;
  user: string;
  id: string;
}

const DEFAULT_DIR = fileURLToPath(new URL("../prompts", import.meta.url));

export class PromptLibrary {
  private readonly prompts = new Map<string, Prompt>();

  constructor(dir: string = DEFAULT_DIR) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const p = parsePrompt(readFileSync(join(dir, file), "utf8"), file);
      const latest = this.prompts.get(p.name);
      if (!latest || latest.version < p.version) this.prompts.set(p.name, p);
      this.prompts.set(p.id, p);
    }
  }

  /** The latest version by name, or an exact version as "name@version". */
  get(name: string): Prompt {
    const p = this.prompts.get(name);
    if (!p) throw new Error(`Unknown prompt ${name}`);
    return p;
  }

  render(name: string, vars: Record<string, string>): { prompt: Prompt; system: string; user: string } {
    const prompt = this.get(name);
    return { prompt, system: fill(prompt.system, vars), user: fill(prompt.user, vars) };
  }
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`Prompt variable ${key} was not provided`);
    return vars[key]!;
  });
}

export function parsePrompt(text: string, file = "prompt"): Prompt {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file}: missing front matter`);
  const meta = Object.fromEntries(
    m[1]!.split(/\r?\n/).map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  const [system, user] = m[2]!.split(/^=== user ===\s*$/m);
  if (!meta.name || !meta.version || user === undefined) throw new Error(`${file}: needs name, version and a "=== user ===" section`);
  const version = Number(meta.version);
  return {
    name: meta.name,
    version,
    effort: (meta.effort as Prompt["effort"]) ?? "low",
    system: system!.trim(),
    user: user.trim(),
    id: `${meta.name}@${version}`,
  };
}
