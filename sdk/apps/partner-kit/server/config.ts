import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";

/** One inventory source. Paths are resolved relative to the agents.yaml file. */
export type ConnectorConfig =
  | { type: "json-file"; path: string }
  | { type: "csv-file"; path: string }
  | { type: "mcp"; command: string; args?: string[]; tool: string; env?: Record<string, string> };

/** An inbound task type this node answers, and the module that answers it. */
export interface ProvideConfig {
  module: string;
  /** Contract version implemented; defaults to 1. */
  version?: number;
  connector?: string;
  options?: Record<string, unknown>;
  description?: string;
}

/**
 * agents.yaml: which agent modules run and which task types they handle. Swapping a module for an
 * external service is a one-line change to `module`.
 */
export interface KitConfig {
  agent: { name: string; description?: string; version?: string };
  connectors: Record<string, ConnectorConfig>;
  provides: Record<string, ProvideConfig>;
  /** Task types operators may start from the outbox. */
  requests: string[];
  /** Default spending limits for outbound requests; the platform policy still has the final say. */
  outbound?: { currency?: string; defaultBudget?: string };
}

export interface KitEnv {
  platformUrl: string;
  agentId: string;
  orgId: string;
  keyFile: string;
  keyPassphrase: string;
  databaseUrl: string;
  port: number;
  host: string;
  publicUrl: string;
  adminPassword: string;
  configPath: string;
  sessionSecret?: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export function envFromProcess(): KitEnv {
  const port = Number(process.env.PORT ?? "9300");
  return {
    platformUrl: process.env.PLATFORM_URL ?? "http://localhost:8080",
    agentId: required("AGENT_ID"),
    orgId: required("ORG_ID"),
    keyFile: required("KEY_FILE"),
    keyPassphrase: required("KEY_PASSPHRASE"),
    databaseUrl: required("DATABASE_URL"),
    port,
    host: process.env.HOST ?? "0.0.0.0",
    publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
    adminPassword: required("KIT_ADMIN_PASSWORD"),
    configPath: process.env.KIT_CONFIG ?? "./config/agents.yaml",
    sessionSecret: process.env.KIT_SESSION_SECRET,
  };
}

export async function loadConfig(path: string): Promise<KitConfig> {
  const raw = parse(await readFile(path, "utf8")) as Partial<KitConfig>;
  if (!raw?.agent?.name) throw new Error(`${path}: agent.name is required`);
  const base = dirname(resolve(path));
  const connectors: Record<string, ConnectorConfig> = {};
  for (const [name, c] of Object.entries(raw.connectors ?? {})) {
    connectors[name] = "path" in c ? { ...c, path: isAbsolute(c.path) ? c.path : resolve(base, c.path) } : c;
  }
  for (const [capability, p] of Object.entries(raw.provides ?? {})) {
    if (!p?.module) throw new Error(`${path}: provides.${capability}.module is required`);
    if (p.connector && !connectors[p.connector]) throw new Error(`${path}: provides.${capability} uses unknown connector ${p.connector}`);
  }
  return {
    agent: raw.agent,
    connectors,
    provides: raw.provides ?? {},
    requests: raw.requests ?? [],
    outbound: raw.outbound,
  };
}
