/**
 * Runs the agent-module golden set against a model.
 *   PISTIVA_LLM=anthropic [PISTIVA_LLM_MODEL=claude-opus-5-5] npm run eval    # Claude API (uses the SDK's credentials)
 *   PISTIVA_LLM=ollama    [PISTIVA_LLM_MODEL=qwen2.5:7b-instruct] npm run eval
 *   npm run eval -- --self-test                                           # graders only, no model (see below)
 * Exits non-zero on any security failure or a pass rate below EVAL_MIN_PASS (default 0.8).
 */
import { writeFile } from "node:fs/promises";
import { AnthropicProvider, LlmRouter, OllamaProvider, runEvals, ScriptedProvider, type LlmProvider, type LlmRequest } from "@pistiva/llm";

/**
 * A rule-based stand-in that answers each prompt the way a correct model should. It checks the
 * harness, schemas and graders end to end; it says nothing about any real model's quality.
 */
function selfTestProvider(): LlmProvider {
  return new ScriptedProvider((req: LlmRequest) => {
    const u = req.user;
    const data = /<untrusted[^>]*>\n([\s\S]*?)\n<\/untrusted>/.exec(u)?.[1] ?? "";
    switch (req.promptId) {
      case "request-interpreter@1": {
        const words: Record<string, number> = { "forty thousand": 40000 };
        const num = Object.entries(words).find(([w]) => data.toLowerCase().includes(w))?.[1] ?? Number(/\b(\d+)\b(?![-\d])/.exec(data.replace(/\d{4}-\d{2}-\d{2}/g, ""))?.[1] ?? 0);
        const sku = /\b([A-Z]{2,}-[A-Z0-9-]+)\b/.exec(data)?.[1] ?? /^- ([A-Z0-9-]+):/m.exec(u)?.[1] ?? "";
        return {
          sku,
          qty: num,
          uom: /\bbox(es)?\b/i.test(data) ? "BOX" : "",
          deliverBy: /\d{4}-\d{2}-\d{2}/.exec(data)?.[0] ?? "",
          specs: /stainless/i.test(data) ? "A2 stainless steel" : "",
          missing: num ? [] : ["qty"],
        };
      }
      case "clarification-advisor@1": {
        const options = [...u.matchAll(/^- (.+)$/gm)].map((m) => m[1]!);
        const prefs = /standing preferences:\n([\s\S]*?)\n\n/.exec(u)?.[1] ?? "";
        const answer = /speed|this week/i.test(prefs) && options.includes("partial") ? "partial" : options.includes("backorder") ? "backorder" : options[0]!;
        return { answer, rationale: "Chosen from the supplier's options using your preferences.", confidence: "medium" };
      }
      case "offer-explainer@1": {
        const chosen = /Chosen: (.+), total (.+)/.exec(u)!;
        return { explanation: `${chosen[1]} was chosen at a total of ${chosen[2]}, the lowest full-quantity offer within budget.` };
      }
      case "spec-check@1": {
        const item = /Supplier's item:\n(.+)/.exec(u)?.[1] ?? "";
        const conflict = (/stainless/i.test(data) && /zinc/i.test(item)) || (/brass|M10/i.test(data) && /M8/.test(item));
        return { matches: !conflict, concern: conflict ? "The item does not match the requested material or size." : "" };
      }
      default:
        throw new Error(`unknown prompt ${req.promptId}`);
    }
  });
}

const selfTest = process.argv.includes("--self-test");
const choice = process.env.PISTIVA_LLM;
const provider: LlmProvider | undefined = selfTest
  ? selfTestProvider()
  : choice === "anthropic"
    ? new AnthropicProvider({ model: process.env.PISTIVA_LLM_MODEL })
    : choice === "ollama"
      ? new OllamaProvider({ model: process.env.PISTIVA_LLM_MODEL, baseUrl: process.env.OLLAMA_URL })
      : undefined;
if (!provider) {
  console.error("Set PISTIVA_LLM=anthropic|ollama to evaluate a model, or pass --self-test to check the harness.");
  process.exit(2);
}

const usage = { input: 0, output: 0 };
const report = await runEvals(new LlmRouter({ provider, onUsage: (u) => { usage.input += u.inputTokens; usage.output += u.outputTokens; } }));
for (const r of report.results) {
  console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.module.padEnd(12)} ${r.id.padEnd(8)}${r.security ? " [security]" : "           "} ${r.code ?? ""} ${r.detail ?? ""}`);
}
const min = Number(process.env.EVAL_MIN_PASS ?? "0.8");
console.log(`\n${selfTest ? "Harness self-test (no model)" : `Provider: ${report.provider}`}: ${(report.passRate * 100).toFixed(0)}% passed, ${report.securityFailures} security failure(s), tokens in/out ${usage.input}/${usage.output}`);
await writeFile("eval-report.json", JSON.stringify({ ...report, selfTest, usage }, null, 2));
process.exitCode = report.securityFailures > 0 || report.passRate < min ? 1 : 0;
