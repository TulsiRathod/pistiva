import { randomUUID } from "node:crypto";
import { signCard, verifyDiscoveredCard } from "./card.ts";
import type { ContractSource, TaskTypeContract } from "./contracts.ts";
import type { Jwks } from "./grant.ts";
import { signJws } from "./jws.ts";
import type { AgentKeyPair } from "./keys.ts";
import {
  AGENT_ASSERTION_TYP,
  type Approval,
  type AgentCard,
  type AgentStatus,
  type DiscoveredAgent,
  type IssuedGrant,
  type SignedReceipt,
} from "./protocol.ts";

/** The subset of the platform a provider gateway depends on; lets tests run without a platform. */
export interface PlatformLookup extends ContractSource {
  readonly issuer: string;
  agentStatus(agentId: string): Promise<AgentStatus>;
  jwks(): Promise<Jwks>;
}

export class PlatformError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

export interface PlatformClientOptions {
  baseUrl: string;
  agentId: string;
  kid: string;
  keys: AgentKeyPair;
  issuer?: string;
  /** How long a peer's status and keys are cached. Short, so revocations take effect quickly. */
  statusTtlMs?: number;
  jwksTtlMs?: number;
}

/**
 * Talks to the control plane as an agent. Each request carries a fresh single-use assertion
 * signed with the agent's own key; no shared API secret exists.
 */
export class PlatformClient implements PlatformLookup {
  readonly issuer: string;
  private readonly statusCache = new Map<string, { value: AgentStatus; until: number }>();
  private jwksCache?: { value: Jwks; until: number };

  constructor(private readonly opts: PlatformClientOptions) {
    this.issuer = opts.issuer ?? "pistiva-platform";
  }

  get agentId(): string {
    return this.opts.agentId;
  }

  get kid(): string {
    return this.opts.kid;
  }

  async publishCard(card: AgentCard): Promise<void> {
    const signature = signCard(card, this.opts.keys);
    await this.call("PUT", `/agents/${card.agentId}/card`, { card, kid: this.opts.kid, signature });
  }

  /** Returns only results whose signed card verifies locally. */
  async discover(capability: string): Promise<DiscoveredAgent[]> {
    const found = await this.call<DiscoveredAgent[]>("GET", `/discovery?capability=${encodeURIComponent(capability)}`);
    return found.filter(verifyDiscoveredCard);
  }

  /** Pass `continueTaskId` to keep a long task (e.g. awaiting a clarification answer) alive under a fresh grant. */
  async requestGrant(req: {
    providerAgentId: string;
    capability: string;
    budget: string;
    currency: string;
    continueTaskId?: string;
    /** An approved approval backing a commitment above the approval threshold. */
    approvalId?: string;
  }): Promise<IssuedGrant> {
    return this.call<IssuedGrant>("POST", "/grants", req);
  }

  /** Asks this agent's organization's human approvers to authorize a commitment. */
  async requestApproval(req: {
    providerAgentId: string;
    capability: string;
    reference: string;
    amount: string;
    currency: string;
    summary?: Record<string, unknown>;
  }): Promise<Approval> {
    return this.call<Approval>("POST", "/approvals", req);
  }

  async approval(id: string): Promise<Approval> {
    return this.call<Approval>("GET", `/approvals/${id}`);
  }

  async submitReceipt(signed: SignedReceipt): Promise<{ taskId: string; status: string; alreadyRecorded: boolean }> {
    return this.call("POST", "/audit/receipts", signed);
  }

  async agentStatus(agentId: string): Promise<AgentStatus> {
    const cached = this.statusCache.get(agentId);
    if (cached && cached.until > Date.now()) return cached.value;
    const value = await this.call<AgentStatus>("GET", `/agents/${agentId}/status`);
    this.statusCache.set(agentId, { value, until: Date.now() + (this.opts.statusTtlMs ?? 30_000) });
    return value;
  }

  /** Contracts are public and immutable per version. */
  async taskType(name: string, version: number): Promise<TaskTypeContract> {
    const res = await fetch(`${this.opts.baseUrl}/task-types/${encodeURIComponent(name)}/versions/${version}`);
    if (!res.ok) throw new PlatformError(res.status, "unknown_task_type", `Task type ${name}@${version} is not registered`);
    return (await res.json()) as TaskTypeContract;
  }

  async jwks(): Promise<Jwks> {
    if (this.jwksCache && this.jwksCache.until > Date.now()) return this.jwksCache.value;
    const res = await fetch(`${this.opts.baseUrl}/.well-known/jwks.json`);
    if (!res.ok) throw new PlatformError(res.status, "jwks_unavailable", "Could not fetch platform JWKS");
    const value = (await res.json()) as Jwks;
    this.jwksCache = { value, until: Date.now() + (this.opts.jwksTtlMs ?? 300_000) };
    return value;
  }

  private assertion(): string {
    const now = Math.floor(Date.now() / 1000);
    return signJws(
      AGENT_ASSERTION_TYP,
      this.opts.kid,
      { iss: this.opts.agentId, aud: this.issuer, iat: now, exp: now + 60, jti: randomUUID() },
      this.opts.keys,
    );
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.assertion()}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      throw new PlatformError(res.status, json?.error ?? "http_error", json?.message ?? `${method} ${path} failed with ${res.status}`);
    }
    return json as T;
  }
}
