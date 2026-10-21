import type { PlatformClient } from "@pistiva/agent-sdk";
import type { Db } from "./db.ts";
import type { OutboundService } from "./outbound.ts";
import type { KitRepo } from "./repo.ts";

export type CommitmentStatus = "confirming" | "awaiting_approval" | "confirmed" | "approval_rejected" | "changes_requested" | "refused" | "failed";

export interface Commitment {
  id: number;
  draftTaskId: string;
  providerAgentId: string;
  providerName: string | null;
  orderRef: string;
  amount: string;
  currency: string;
  approvalId: string | null;
  status: CommitmentStatus;
  confirmTaskId: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : d);

function toCommitment(r: Record<string, any>): Commitment {
  return {
    id: Number(r.id),
    draftTaskId: r.draft_task_id,
    providerAgentId: r.provider_agent_id,
    providerName: r.provider_name,
    orderRef: r.order_ref,
    amount: r.amount,
    currency: r.currency,
    approvalId: r.approval_id,
    status: r.status,
    confirmTaskId: r.confirm_task_id,
    note: r.note,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/**
 * Turns a held draft into a confirmed order. The node first tries to confirm; when the platform
 * answers that a human approval is required, it files one with the organization's approvers and
 * confirms only after an approver approves it in the console. The node never decides on its own.
 */
export class CommitmentService {
  private polling = false;

  /** Polling of the approvals it waits on runs as a recurring job (see kit.ts). */
  constructor(private readonly deps: { db: Db; repo: KitRepo; outbound: OutboundService; platform: PlatformClient }) {}

  async list(): Promise<Commitment[]> {
    const { rows } = await this.deps.db.query("SELECT * FROM kit_commitments ORDER BY updated_at DESC LIMIT 100");
    return rows.map(toCommitment);
  }

  async forDraft(draftTaskId: string): Promise<Commitment | undefined> {
    const { rows } = await this.deps.db.query("SELECT * FROM kit_commitments WHERE draft_task_id = $1", [draftTaskId]);
    return rows[0] ? toCommitment(rows[0]) : undefined;
  }

  /** Starts committing a completed order.draft task. Returns once the first attempt has finished. */
  async commit(draftTaskId: string): Promise<Commitment> {
    const task = await this.deps.repo.getTask(draftTaskId);
    if (!task || task.direction !== "outbound" || task.capability !== "order.draft" || task.state !== "completed") {
      throw new Error("Only a completed draft order you requested can be committed");
    }
    const existing = await this.forDraft(draftTaskId);
    if (existing && existing.status !== "failed" && existing.status !== "refused") {
      throw new Error(`This order is already ${existing.status.replace("_", " ")}`);
    }
    const draft = (await this.deps.repo.messages(draftTaskId)).find((m) => m.sender === "peer" && m.kind === "result")?.data as
      | { orderRef?: string; total?: string; currency?: string }
      | undefined;
    if (!draft?.orderRef || !draft.total || !draft.currency) throw new Error("The draft has no order reference or total");

    const { rows } = await this.deps.db.query(
      `INSERT INTO kit_commitments (draft_task_id, provider_agent_id, provider_name, order_ref, amount, currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'confirming')
       ON CONFLICT (draft_task_id) DO UPDATE SET status = 'confirming', note = NULL, approval_id = NULL, updated_at = now()
       RETURNING *`,
      [draftTaskId, task.peerAgentId, task.peerName, draft.orderRef, draft.total, draft.currency],
    );
    return this.attempt(toCommitment(rows[0]));
  }

  /** Checks the approvals the node is waiting on and acts on decisions. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const { rows } = await this.deps.db.query("SELECT * FROM kit_commitments WHERE status = 'awaiting_approval'");
      for (const c of rows.map(toCommitment)) {
        const approval = await this.deps.platform.approval(c.approvalId!).catch(() => undefined);
        if (!approval || approval.status === "PENDING") continue;
        if (approval.status === "APPROVED") {
          await this.update(c.id, { status: "confirming" });
          await this.attempt({ ...c, status: "confirming" }, approval.id);
        } else {
          await this.update(c.id, {
            status: approval.status === "REJECTED" ? "approval_rejected" : "changes_requested",
            note: approval.comment ?? undefined,
          });
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async attempt(c: Commitment, approvalId?: string): Promise<Commitment> {
    const provider = (await this.deps.outbound.discover("order.confirm")).find((a) => a.agentId === c.providerAgentId);
    if (!provider) return this.update(c.id, { status: "failed", note: "The supplier is no longer listed for order.confirm" });

    const run = await this.deps.outbound.runOne(
      provider,
      { capability: "order.confirm", request: { orderRef: c.orderRef, ...(approvalId ? { approvalId } : {}) }, budget: c.amount, currency: c.currency },
      approvalId,
    );
    if (run.state === "completed" && run.result?.status === "confirmed") {
      return this.update(c.id, { status: "confirmed", confirmTaskId: run.taskId, note: run.result.expectedShipDate ? `Ships ${run.result.expectedShipDate}` : undefined });
    }
    if (run.errorCode === "approval_required" && !approvalId) {
      const approval = await this.deps.platform.requestApproval({
        providerAgentId: c.providerAgentId,
        capability: "order.confirm",
        reference: c.orderRef,
        amount: c.amount,
        currency: c.currency,
        summary: { orderRef: c.orderRef, supplier: c.providerName, draftTaskId: c.draftTaskId },
      });
      return this.update(c.id, { status: "awaiting_approval", approvalId: approval.id, note: run.reason });
    }
    return this.update(c.id, { status: run.state === "completed" || run.state === "rejected" ? "refused" : "failed", confirmTaskId: run.taskId, note: run.reason });
  }

  private async update(id: number, patch: { status: CommitmentStatus; approvalId?: string; confirmTaskId?: string; note?: string }): Promise<Commitment> {
    const { rows } = await this.deps.db.query(
      `UPDATE kit_commitments SET status = $2, approval_id = COALESCE($3, approval_id), confirm_task_id = COALESCE($4, confirm_task_id),
         note = $5, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, patch.status, patch.approvalId ?? null, patch.confirmTaskId ?? null, patch.note ?? null],
    );
    return toCommitment(rows[0]);
  }
}
