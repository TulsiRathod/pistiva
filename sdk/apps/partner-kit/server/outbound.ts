import { randomUUID } from "node:crypto";
import {
  A2AClient,
  ContractRegistry,
  PlatformError,
  singleDataPart,
  TERMINAL_STATES,
  type A2AOutcome,
  type AgentKeyPair,
  type Clarification,
  type DiscoveredAgent,
  type OutboundRound,
  type PlatformClient,
} from "@pistiva/agent-sdk";
import type { Suggestion } from "@pistiva/llm";
import type { JobQueue } from "./jobs.ts";
import type { KitRepo } from "./repo.ts";

/** How long an operator has to answer a supplier's question before the task is canceled. */
export const ANSWER_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** A task with no progress this long is checked with the supplier; after the second limit it fails. */
const RECOVER_AFTER_MS = 10 * 60_000;
const GIVE_UP_AFTER_MS = 60 * 60_000;

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
 * Requests this node sends to other businesses' agents. A supplier's clarifying question does not
 * hold a process waiting: the task is recorded as waiting, and the operator's answer becomes a
 * durable job that resumes it under a continuation grant, on any replica, after any restart.
 */
export class OutboundService {
  private readonly running = new Set<Promise<unknown>>();
  /** Tasks this process is driving right now; recovery leaves them alone. */
  private readonly active = new Set<string>();
  private readonly contracts: ContractRegistry;

  constructor(
    private readonly deps: {
      platform: PlatformClient;
      keys: AgentKeyPair;
      repo: KitRepo;
      jobs: JobQueue;
      /** Drafts an answer for the operator; never sent without them. */
      suggest?: (input: { request: Record<string, unknown>; question: string; options?: string[] }) => Promise<Suggestion | undefined>;
    },
  ) {
    this.contracts = new ContractRegistry(deps.platform);
    deps.jobs.register("outbound.resume", (p) => this.resume(Number(p.questionId)));
    deps.jobs.register("questions.expire", () => this.expireQuestions());
    deps.jobs.register("outbound.recover", () => this.recoverStalled());
    deps.jobs.register("receipts.resubmit", () => this.resubmitReceipts());
  }

  /** One client per task, so each grant and round is recorded against its own request. */
  private clientFor(req: Omit<OutboundRequest, "providerAgentIds">, version: number, granted: (taskId: string) => void): A2AClient {
    return new A2AClient({
      platform: this.deps.platform,
      keys: this.deps.keys,
      contracts: this.contracts,
      onGrant: async (grant, provider) => {
        granted(grant.taskId);
        this.active.add(grant.taskId);
        await this.deps.repo.upsertTask({
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
          request: req.request,
          provider,
        });
      },
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
    for (const provider of providers) this.track(this.runOne(provider, req));
    return { providers: providers.map((p) => ({ agentId: p.agentId, orgName: p.orgName })) };
  }

  /**
   * Runs one task until it ends or waits for an operator, and records it in the outbox. Never throws:
   * a failure is returned (and recorded) so callers such as the commit flow can react to it.
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
      return await this.finish(provider, req.capability, version, outcome);
    } catch (e) {
      return this.fail(provider, req, version, taskId, e);
    } finally {
      if (taskId) this.active.delete(taskId);
    }
  }

  /** Records an operator's answer (or refusal) and schedules the task to continue. */
  async answer(questionId: number, answer: string | null): Promise<boolean> {
    const resolved = await this.deps.repo.resolveQuestion(questionId, answer === null ? "declined" : "answered", answer ?? undefined);
    if (!resolved) return false;
    await this.deps.jobs.enqueue("outbound.resume", { questionId }, { uniqueKey: `resume:${questionId}` });
    this.track(this.deps.jobs.drain());
    return true;
  }

  /** Waits for every background task and due job; used by tests and graceful shutdown. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  private track(p: Promise<unknown>): void {
    const run = p.finally(() => this.running.delete(run));
    this.running.add(run);
  }

  /** A question opens an operator task and leaves the A2A task waiting at the provider. */
  private async ask(c: Clarification, ctx: { taskId: string; round: number }, request: Record<string, unknown>): Promise<undefined> {
    const id = await this.deps.repo.openQuestion(ctx.taskId, ctx.round, c);
    if (this.deps.suggest) {
      // Computed in the background; the question is visible to the operator at once.
      this.track(
        this.deps
          .suggest({ request, question: c.question, options: c.options })
          .then((s) => s && this.deps.repo.setSuggestion(id, s))
          .catch(() => undefined),
      );
    }
    return undefined;
  }

  private async resume(questionId: number): Promise<void> {
    const q = await this.deps.repo.getQuestion(questionId);
    const ctx = q && (await this.deps.repo.taskContext(q.taskId));
    if (!q || !ctx?.provider) throw new Error(`Cannot resume question ${questionId}: task context is missing`);
    const { task, provider, request } = ctx;
    if (q.status === "declined") {
      await this.cancelAtProvider(provider, task.id, "You declined to answer the supplier's question");
      return;
    }
    if (q.status !== "answered" || !q.answer) return;
    const req = { capability: task.capability, request: request ?? {}, budget: task.budget ?? "0.00", currency: task.currency ?? "INR" };
    let taskId: string | undefined = task.id;
    this.active.add(task.id);
    try {
      const outcome = await this.clientFor(req, task.taskTypeVersion, (id) => (taskId = id)).resume(
        provider,
        { taskId: task.id, capability: task.capability, round: q.round + 1, answer: { answer: q.answer } },
        { budget: req.budget, currency: req.currency },
        (c, next) => this.ask(c, next, req.request),
      );
      await this.finish(provider, task.capability, task.taskTypeVersion, outcome);
    } catch (e) {
      // A grant denial or an unreachable supplier is final for this answer; transport hiccups retry.
      if (e instanceof PlatformError) await this.fail(provider, req, task.taskTypeVersion, taskId, e);
      else throw e;
    } finally {
      this.active.delete(task.id);
    }
  }

  /** Questions nobody answered in time: cancel the task at the supplier and close it here. */
  private async expireQuestions(): Promise<void> {
    for (const q of await this.deps.repo.openQuestionsOlderThan(ANSWER_TIMEOUT_MS)) {
      if (!(await this.deps.repo.resolveQuestion(q.id, "expired"))) continue;
      const ctx = await this.deps.repo.taskContext(q.taskId);
      if (ctx?.provider) await this.cancelAtProvider(ctx.provider, q.taskId, "No answer within 24 hours");
    }
  }

  /** Tasks the supplier stopped answering: ask the supplier for the task's state, then give up. */
  private async recoverStalled(): Promise<void> {
    for (const { task, provider } of await this.deps.repo.stalledOutbound(RECOVER_AFTER_MS)) {
      if (this.active.has(task.id) || !provider) continue;
      const remote = await new A2AClient({ platform: this.deps.platform, keys: this.deps.keys }).getTask(provider, task.id).catch(() => undefined);
      const state = remote?.status.state;
      if (state && (TERMINAL_STATES as readonly string[]).includes(state)) {
        const data = singleDataPart(remote.status.message?.parts);
        await this.deps.repo.upsertTask({ ...task, state, summary: summarize(task.capability, data) ?? `Recovered from the supplier: ${state}` });
      } else if (Date.now() - Date.parse(task.updatedAt) > GIVE_UP_AFTER_MS) {
        await this.deps.repo.upsertTask({ ...task, state: "failed", error: "The supplier stopped responding" });
      }
    }
  }

  /** Receipts the platform didn't accept the first time (it was down, or a network error). */
  private async resubmitReceipts(): Promise<void> {
    for (const r of await this.deps.repo.unrecordedReceipts()) {
      await this.deps.platform.submitReceipt(r.signed);
      await this.deps.repo.markRecorded(r.taskId, r.round);
    }
  }

  private async cancelAtProvider(provider: DiscoveredAgent, taskId: string, reason: string): Promise<void> {
    await new A2AClient({ platform: this.deps.platform, keys: this.deps.keys }).cancel(provider, taskId).catch(() => undefined);
    const task = await this.deps.repo.getTask(taskId);
    if (task) await this.deps.repo.upsertTask({ ...task, state: "canceled", summary: reason });
  }

  private async finish(provider: DiscoveredAgent, capability: string, version: number, outcome: A2AOutcome<unknown>): Promise<RunResult> {
    await this.deps.repo.upsertTask({
      id: outcome.taskId,
      direction: "outbound",
      peerAgentId: provider.agentId,
      capability,
      taskTypeVersion: version,
      state: outcome.state,
      summary: outcome.state === "completed" ? summarize(capability, outcome.result as Record<string, unknown>) : outcome.reason,
    });
    return { taskId: outcome.taskId, state: outcome.state, result: outcome.result as Record<string, unknown> | undefined, reason: outcome.reason };
  }

  private async fail(provider: DiscoveredAgent, req: Omit<OutboundRequest, "providerAgentIds">, version: number, taskId: string | undefined, e: unknown): Promise<RunResult> {
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
