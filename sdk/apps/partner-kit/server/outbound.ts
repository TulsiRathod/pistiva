import { randomUUID } from "node:crypto";
import { A2AClient, ContractRegistry, PlatformError, singleDataPart, type AgentKeyPair, type Clarification, type DiscoveredAgent, type OutboundRound, type PlatformClient } from "@pistiva/agent-sdk";
import type { Suggestion } from "@pistiva/llm";
import type { KitRepo } from "./repo.ts";

/** How long an operator has to answer a supplier's question before the task is canceled. */
const ANSWER_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** How one outbound task ended. `errorCode` carries the platform's reason when no grant was issued. */
export interface RunResult {
  taskId: string;
  state: string;
  result?: Record<string, unknown>;
  reason?: string;
  errorCode?: string;
}

export interface OutboundRequest {
  capability: string;
  request: Record<string, unknown>;
  budget: string;
  currency: string;
  /** Agents to ask; empty means every verified agent discovery returns for the capability. */
  providerAgentIds?: string[];
}

/** One-line description of a reply, for task lists. */
export function summarize(capability: string, data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  if (capability === "quote.request") {
    if (data.available === false) return `Not available${data.terms ? ` · ${data.terms}` : ""}`;
    return [data.qty && `${data.qty} ${data.uom ?? ""}`.trim(), data.unitPrice && `${data.unitPrice} ${data.currency ?? ""}`.trim(), data.leadTimeDays !== undefined && `${data.leadTimeDays} days`]
      .filter(Boolean)
      .join(" · ");
  }
  if ("orderRef" in data) return `${data.orderRef} · ${data.status}${data.total ? ` · ${data.total} ${data.currency ?? ""}` : ""}`;
  if ("question" in data) return String(data.question);
  return JSON.stringify(data).slice(0, 120);
}

/**
 * Requests this node sends to other businesses' agents. Runs each task in the background; when a
 * supplier asks a clarifying question, the task waits for an operator to answer it in the UI.
 */
export class OutboundService {
  private readonly waiters = new Map<number, (answer: { answer: string } | null) => void>();
  private readonly running = new Set<Promise<unknown>>();
  private readonly contracts: ContractRegistry;

  constructor(
    private readonly deps: {
      platform: PlatformClient;
      keys: AgentKeyPair;
      repo: KitRepo;
      /** Drafts an answer for the operator; never sent without them. */
      suggest?: (input: { request: Record<string, unknown>; question: string; options?: string[] }) => Promise<Suggestion | undefined>;
    },
  ) {
    this.contracts = new ContractRegistry(deps.platform);
  }

  /** One client per task, so each grant and round is recorded against its own request. */
  private clientFor(req: OutboundRequest, version: number, granted: (taskId: string) => void): A2AClient {
    return new A2AClient({
      platform: this.deps.platform,
      keys: this.deps.keys,
      contracts: this.contracts,
      onGrant: (grant, provider) => (granted(grant.taskId), this.deps.repo.upsertTask({
          id: grant.taskId,
          direction: "outbound",
          peerAgentId: provider.agentId,
          peerName: provider.orgName,
          capability: req.capability,
          taskTypeVersion: version,
          state: "submitted",
          budget: req.budget,
          currency: req.currency,
          approvalRequired: grant.approvalRequired,
        })),
      onRound: (e) => this.recordRound(e),
    });
  }

  async discover(capability: string): Promise<DiscoveredAgent[]> {
    return (await this.deps.platform.discover(capability)).filter((a) => a.agentId !== this.deps.platform.agentId);
  }

  /** Starts one task per provider and returns immediately; progress is visible in the outbox. */
  async start(req: OutboundRequest): Promise<{ providers: { agentId: string; orgName: string }[] }> {
    const all = await this.discover(req.capability);
    const providers = req.providerAgentIds?.length ? all.filter((a) => req.providerAgentIds!.includes(a.agentId)) : all;
    for (const provider of providers) {
      const run = this.runOne(provider, req).finally(() => this.running.delete(run));
      this.running.add(run);
    }
    return { providers: providers.map((p) => ({ agentId: p.agentId, orgName: p.orgName })) };
  }

  /**
   * Runs one task to its end and records it in the outbox. Never throws: a failure is returned
   * (and recorded) so callers such as the commit flow can react to it.
   */
  async runOne(provider: DiscoveredAgent, req: Omit<OutboundRequest, "providerAgentIds">, approvalId?: string): Promise<RunResult> {
    const version = provider.card.capabilities.find((c) => c.name === req.capability)?.version ?? 1;
    let taskId: string | undefined;
    try {
      const outcome = await this.clientFor(req, version, (id) => (taskId = id)).run(
        provider,
        req.capability,
        req.request,
        { budget: req.budget, currency: req.currency, approvalId },
        (c, ctx) => this.ask(c, ctx, req.request),
      );
      await this.deps.repo.upsertTask({
        id: outcome.taskId,
        direction: "outbound",
        peerAgentId: provider.agentId,
        capability: req.capability,
        taskTypeVersion: version,
        state: outcome.state,
        summary: outcome.state === "completed" ? summarize(req.capability, outcome.result as Record<string, unknown>) : outcome.reason,
      });
      return { taskId: outcome.taskId, state: outcome.state, result: outcome.result as Record<string, unknown> | undefined, reason: outcome.reason };
    } catch (e) {
      // Failed after the grant (provider unreachable, bad reply): close the task we already recorded.
      // Denied before any grant (policy, rate limit): there is no task, so record it under a local id.
      const id = taskId ?? `local-${randomUUID()}`;
      await this.deps.repo.upsertTask({
        id,
        direction: "outbound",
        peerAgentId: provider.agentId,
        peerName: provider.orgName,
        capability: req.capability,
        taskTypeVersion: version,
        state: taskId ? "failed" : "rejected",
        budget: req.budget,
        currency: req.currency,
        error: (e as Error).message,
      });
      return { taskId: id, state: taskId ? "failed" : "rejected", reason: (e as Error).message, errorCode: e instanceof PlatformError ? e.code : undefined };
    }
  }
  /** Resolves a waiting clarification. Returns false when no task is waiting on it any more. */
  async answer(questionId: number, answer: string | null): Promise<boolean> {
    const waiter = this.waiters.get(questionId);
    const resolved = await this.deps.repo.resolveQuestion(questionId, waiter ? (answer === null ? "declined" : "answered") : "expired", answer ?? undefined);
    if (!waiter || !resolved) return false;
    this.waiters.delete(questionId);
    waiter(answer === null ? null : { answer });
    return true;
  }

  /** Waits for every background task; used by tests and graceful shutdown. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  private async ask(c: Clarification, ctx: { taskId: string; round: number }, request: Record<string, unknown>): Promise<{ answer: string } | null> {
    const id = await this.deps.repo.openQuestion(ctx.taskId, ctx.round, c);
    // The suggestion is computed in the background; the question is visible to the operator at once.
    if (this.deps.suggest) {
      void this.deps
        .suggest({ request, question: c.question, options: c.options })
        .then((s) => s && this.deps.repo.setSuggestion(id, s))
        .catch(() => undefined);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        void this.deps.repo.resolveQuestion(id, "expired");
        resolve(null);
      }, ANSWER_TIMEOUT_MS);
      timer.unref?.();
      this.waiters.set(id, (a) => {
        clearTimeout(timer);
        resolve(a);
      });
    });
  }

  private async recordRound(e: OutboundRound): Promise<void> {
    const { repo } = this.deps;
    const state = e.task.status.state;
    const data = singleDataPart(e.task.status.message?.parts);
    const text = e.task.status.message?.parts.find((p) => p.kind === "text");
    const capability = e.record.receipt.receipt.capability;
    await repo.upsertTask({
      id: e.taskId,
      direction: "outbound",
      peerAgentId: e.record.receipt.receipt.providerAgentId,
      capability,
      taskTypeVersion: e.record.receipt.receipt.taskTypeVersion,
      state,
      rounds: e.round,
      summary: summarize(capability, data),
    });
    await repo.addMessage(e.taskId, { round: e.round, sender: "us", kind: e.kind, data: e.sent });
    await repo.addMessage(e.taskId, {
      round: e.round,
      sender: "peer",
      kind: state === "input-required" ? "clarification" : "result",
      state,
      data: data ?? (text?.kind === "text" ? { reason: text.text } : null),
    });
    await repo.saveReceipt(e.taskId, e.record.receipt, { countersigned: true, recorded: e.record.recorded });
  }
}
