/** Shared setup for scripts that run against a live platform: register, verify and key organizations. */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPair, kidFor, saveKeyFile, type AgentKeyPair } from "@pistiva/agent-sdk";

export const PLATFORM_URL = process.env.PLATFORM_URL ?? "http://localhost:8080";
const ADMIN_EMAIL = process.env.PISTIVA_ADMIN_EMAIL ?? "admin@pistiva.local";
const ADMIN_PASSWORD = process.env.PISTIVA_ADMIN_PASSWORD ?? "change-me-admin";
export const PASSPHRASE = process.env.KEY_PASSPHRASE ?? "demo-passphrase";

export interface Bootstrapped {
  orgId: string;
  orgName: string;
  userToken: string;
  agentId: string;
  kid: string;
  keys: AgentKeyPair;
  keyFile: string;
}

export async function api<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const res = await fetch(PLATFORM_URL + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}

export async function waitForPlatform(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${PLATFORM_URL}/actuator/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Platform not reachable at ${PLATFORM_URL}`);
}

/** One run of a script: a random suffix keeps organizations and domains unique across runs. */
export class Bootstrapper {
  readonly run = randomBytes(3).toString("hex");
  readonly keyDir = join(fileURLToPath(new URL("../..", import.meta.url)), ".demo", this.run);
  private adminToken?: string;

  async admin(): Promise<string> {
    this.adminToken ??= (await api<{ accessToken: string }>("POST", "/auth/login", undefined, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).accessToken;
    return this.adminToken;
  }

  /** Registers and verifies an organization, creates its agent and registers a locally generated key. */
  async org(slug: string, orgName: string, endpoint: string): Promise<Bootstrapped> {
    const { accessToken } = await api<{ accessToken: string }>("POST", "/auth/register", undefined, {
      email: `owner@${slug}-${this.run}.example.com`,
      password: "demo-password-123",
      orgName,
      domain: `${slug}-${this.run}.example.com`,
    });
    const me = await api<{ organizations: { orgId: string }[] }>("GET", "/me", accessToken);
    const orgId = me.organizations[0]!.orgId;
    await api("POST", `/orgs/${orgId}/verify`, await this.admin(), { method: "manual" });
    const agent = await api<{ id: string }>("POST", "/agents", accessToken, { orgId, name: `${orgName} agent`, version: "0.1.0", endpointUrl: endpoint });

    // The private key is generated and kept locally; only the public key goes to the platform.
    const keys = generateKeyPair();
    const keyFile = join(this.keyDir, `${slug}.key.json`);
    await saveKeyFile(keyFile, keys, PASSPHRASE);
    const { kid } = await api<{ kid: string }>("POST", `/agents/${agent.id}/keys`, accessToken, { publicKey: keys.publicKey });
    if (kid !== kidFor(keys.publicKey)) throw new Error("Platform and SDK disagree on the key id");
    return { orgId, orgName, userToken: accessToken, agentId: agent.id, kid, keys, keyFile };
  }
}
