#!/usr/bin/env -S npx tsx
/**
 * pistiva-certify: runs the conformance suite against a partner agent as a certifier's agent.
 *
 *   pistiva-certify --agent <agentId> [--capability quote.request] [--sample '{"sku":"…","qty":1}' | --sample @sample.json]
 *                   [--submit] [--out report.json] [--json]
 *
 * The certifier's identity comes from the environment:
 *   PLATFORM_URL          control plane (default http://localhost:8080)
 *   CERTIFIER_AGENT_ID    the certifier's agent id
 *   CERTIFIER_KEY_FILE    its encrypted key file, unlocked with KEY_PASSPHRASE
 *
 * Exit code 0 when every check passes, 1 when any fails, 2 on a usage or setup error.
 * Without --submit nothing is recorded, so partners can run it against themselves before applying.
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { kidFor, loadKeyFile, PlatformClient } from "@pistiva/agent-sdk";
import { runConformance, type CheckResult } from "./suite.ts";

const USAGE = "Usage: pistiva-certify --agent <agentId> [--capability <name>] [--sample <json|@file>] [--submit] [--out <file>] [--json]";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      agent: { type: "string" },
      capability: { type: "string", default: "quote.request" },
      sample: { type: "string" },
      budget: { type: "string", default: "1.00" },
      currency: { type: "string", default: "INR" },
      submit: { type: "boolean", default: false },
      out: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const certifierId = process.env.CERTIFIER_AGENT_ID;
  const keyFile = process.env.CERTIFIER_KEY_FILE;
  if (!values.agent || !certifierId || !keyFile) {
    console.error(USAGE + "\nCERTIFIER_AGENT_ID and CERTIFIER_KEY_FILE must be set.");
    return 2;
  }
  const sample = values.sample
    ? (JSON.parse(values.sample.startsWith("@") ? await readFile(values.sample.slice(1), "utf8") : values.sample) as Record<string, unknown>)
    : undefined;

  const keys = await loadKeyFile(keyFile, process.env.KEY_PASSPHRASE ?? "");
  const platform = new PlatformClient({
    baseUrl: process.env.PLATFORM_URL ?? "http://localhost:8080",
    agentId: certifierId,
    kid: kidFor(keys.publicKey),
    keys,
    statusTtlMs: 0,
  });
  const provider = (await platform.discover(values.capability!)).find((d) => d.agentId === values.agent);
  if (!provider) {
    console.error(`Agent ${values.agent} is not discoverable for ${values.capability} (is its card published and its organization verified?)`);
    return 2;
  }

  const print = (c: CheckResult) => {
    if (!values.json) console.log(`  ${c.passed ? "PASS" : "FAIL"}  ${c.title}${c.detail ? ` — ${c.detail}` : ""}`);
  };
  if (!values.json) console.log(`Certifying ${provider.orgName} (${provider.agentId}) for ${values.capability} at ${provider.card.endpoint}\n`);
  const report = await runConformance({
    platform,
    keys,
    provider,
    capability: values.capability!,
    sample,
    spend: { budget: values.budget!, currency: values.currency! },
    onCheck: print,
  });

  if (values.out) await writeFile(values.out, JSON.stringify(report, null, 2));
  let recorded: string | undefined;
  if (values.submit) {
    const c = await platform.submitCertification(provider.agentId, report);
    recorded = `${c.status} (${c.checksPassed}/${c.checksTotal}) recorded as ${c.id}, valid until ${c.expiresAt}`;
  }
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const failed = report.checks.filter((c) => !c.passed).length;
    console.log(`\n${failed === 0 ? "All checks passed" : `${failed} of ${report.checks.length} checks failed`}.`);
    if (recorded) console.log(`Certification ${recorded}`);
  }
  return report.passed ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  },
);
