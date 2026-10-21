import type { DiscoveredAgent, SignedReceipt, TaskState } from "@pistiva/agent-sdk";
import type { AuditSink, NonceStore, StoredTask, TaskStore } from "@pistiva/gateway";
import type { DraftOrder, DraftStore } from "@pistiva/procurement";
import type { Db } from "./db.ts";

export type Direction = "inbound" | "outbound";

export interface KitTask {
  id: string;
  direction: Direction;
  peerAgentId: string;
  peerName: string | null;
  capability: string;
  taskTypeVersion: number;
  state: TaskState | "submitted";
  rounds: number;
  budget: string | null;
  currency: string | null;
  approvalRequired: boolean;
  summary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KitMessage {
  id: number;
  round: number;
  sender: "us" | "peer";
  kind: string;
  state: string | null;
  data: unknown;
  withheld: string[] | null;
  createdAt: string;
}

export interface KitReceipt {
  round: number;
  state: string;
  signed: SignedReceipt;
  countersigned: boolean;
  recorded: boolean;
  createdAt: string;
}

export interface KitQuestion {
  id: number;
  taskId: string;
  round: number;
  question: { question: string; field?: string; options?: string[] };
  answer: string | null;
  status: "open" | "answered" | "declined" | "expired";
  createdAt: string;
  /** A model's suggested answer, for the operator to accept or ignore. */
  suggestion?: { answer: string; rationale: string; confidence: string; suspicious: boolean; promptId: string } | null;
  capability?: string;
  peerName?: string | null;
}

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : d);

function toTask(r: Record<string, any>): KitTask {
  return {
    id: r.id,
    direction: r.direction,
    peerAgentId: r.peer_agent_id,
    peerName: r.peer_name,
    capability: r.capability,
    taskTypeVersion: r.task_type_version,
    state: r.state,
    rounds: r.rounds,
    budget: r.budget,
    currency: r.currency,
    approvalRequired: r.approval_required,
    summary: r.summary,
    error: r.error,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/** Data access for the node's own database. */
export class KitRepo {
  constructor(private readonly db: Db) {}

  async upsertTask(
    t: Pick<KitTask, "id" | "direction" | "peerAgentId" | "capability" | "taskTypeVersion" | "state"> &
      Partial<KitTask> & { request?: Record<string, unknown>; provider?: DiscoveredAgent },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO kit_tasks (id, direction, peer_agent_id, peer_name, capability, task_type_version, state, rounds, budget, currency, approval_required, summary, error, request, provider)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (id) DO UPDATE SET
         state = EXCLUDED.state,
         rounds = GREATEST(kit_tasks.rounds, EXCLUDED.rounds),
         peer_name = COALESCE(EXCLUDED.peer_name, kit_tasks.peer_name),
         summary = COALESCE(EXCLUDED.summary, kit_tasks.summary),
         budget = COALESCE(kit_tasks.budget, EXCLUDED.budget),
         currency = COALESCE(kit_tasks.currency, EXCLUDED.currency),
         request = COALESCE(kit_tasks.request, EXCLUDED.request),
         provider = COALESCE(EXCLUDED.provider, kit_tasks.provider),
         error = EXCLUDED.error,
         approval_required = kit_tasks.approval_required OR EXCLUDED.approval_required,
         updated_at = now()`,
      [t.id, t.direction, t.peerAgentId, t.peerName ?? null, t.capability, t.taskTypeVersion, t.state, t.rounds ?? 0,
        t.budget ?? null, t.currency ?? null, t.approvalRequired ?? false, t.summary ?? null, t.error ?? null,
        t.request ? JSON.stringify(t.request) : null, t.provider ? JSON.stringify(t.provider) : null],
    );
  }

  /** What a resumable outbound task needs: the task, its original request and the provider it went to. */
  async taskContext(id: string): Promise<{ task: KitTask; request?: Record<string, unknown>; provider?: DiscoveredAgent } | undefined> {
    const { rows } = await this.db.query("SELECT * FROM kit_tasks WHERE id = $1", [id]);
    return rows[0] ? { task: toTask(rows[0]), request: rows[0].request ?? undefined, provider: rows[0].provider ?? undefined } : undefined;
  }

  /** Outbound tasks still in flight with no progress for `ms`. */
  async stalledOutbound(ms: number): Promise<{ task: KitTask; provider?: DiscoveredAgent }[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM kit_tasks WHERE direction = 'outbound' AND state IN ('submitted', 'working')
       AND updated_at < now() - ($1 || ' milliseconds')::interval AND id NOT LIKE 'local-%'`,
      [String(ms)],
    );
    return rows.map((r) => ({ task: toTask(r), provider: r.provider ?? undefined }));
  }

  async unrecordedReceipts(): Promise<{ taskId: string; round: number; signed: SignedReceipt }[]> {
    const { rows } = await this.db.query(
      `SELECT r.task_id, r.round, r.signed FROM kit_receipts r JOIN kit_tasks t ON t.id = r.task_id
       WHERE t.direction = 'outbound' AND r.countersigned AND NOT r.recorded LIMIT 50`,
    );
    return rows.map((r) => ({ taskId: r.task_id, round: r.round, signed: r.signed }));
  }

  async markRecorded(taskId: string, round: number): Promise<void> {
    await this.db.query("UPDATE kit_receipts SET recorded = TRUE WHERE task_id = $1 AND round = $2", [taskId, round]);
  }

  async getQuestion(id: number): Promise<KitQuestion | undefined> {
    const { rows } = await this.db.query("SELECT * FROM kit_questions WHERE id = $1", [id]);
    return rows[0] ? this.toQuestion(rows[0]) : undefined;
  }

  async openQuestionsOlderThan(ms: number): Promise<KitQuestion[]> {
    const { rows } = await this.db.query(
      "SELECT * FROM kit_questions WHERE status = 'open' AND created_at < now() - ($1 || ' milliseconds')::interval",
      [String(ms)],
    );
    return rows.map((r) => this.toQuestion(r));
  }

  async listTasks(direction?: Direction, limit = 100): Promise<KitTask[]> {
    const { rows } = direction
      ? await this.db.query("SELECT * FROM kit_tasks WHERE direction = $1 ORDER BY updated_at DESC LIMIT $2", [direction, limit])
      : await this.db.query("SELECT * FROM kit_tasks ORDER BY updated_at DESC LIMIT $1", [limit]);
    return rows.map(toTask);
  }

  async getTask(id: string): Promise<KitTask | undefined> {
    const { rows } = await this.db.query("SELECT * FROM kit_tasks WHERE id = $1", [id]);
    return rows[0] ? toTask(rows[0]) : undefined;
  }

  async addMessage(taskId: string, m: { round: number; sender: "us" | "peer"; kind: string; state?: string; data: unknown; withheld?: string[] }) {
    await this.db.query(
      "INSERT INTO kit_messages (task_id, round, sender, kind, state, data, withheld) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [taskId, m.round, m.sender, m.kind, m.state ?? null, JSON.stringify(m.data ?? null), m.withheld ? JSON.stringify(m.withheld) : null],
    );
  }

  async messages(taskId: string): Promise<KitMessage[]> {
    const { rows } = await this.db.query("SELECT * FROM kit_messages WHERE task_id = $1 ORDER BY id", [taskId]);
    return rows.map((r) => ({ id: Number(r.id), round: r.round, sender: r.sender, kind: r.kind, state: r.state, data: r.data, withheld: r.withheld, createdAt: iso(r.created_at) }));
  }

  async saveReceipt(taskId: string, signed: SignedReceipt, flags: { countersigned: boolean; recorded?: boolean }) {
    await this.db.query(
      `INSERT INTO kit_receipts (task_id, round, state, signed, countersigned, recorded) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (task_id, round) DO UPDATE SET
         signed = CASE WHEN EXCLUDED.countersigned THEN EXCLUDED.signed ELSE kit_receipts.signed END,
         countersigned = kit_receipts.countersigned OR EXCLUDED.countersigned,
         recorded = kit_receipts.recorded OR EXCLUDED.recorded`,
      [taskId, signed.receipt.round, signed.receipt.state, JSON.stringify(signed), flags.countersigned, flags.recorded ?? false],
    );
  }

  async receipts(taskId: string): Promise<KitReceipt[]> {
    const { rows } = await this.db.query("SELECT * FROM kit_receipts WHERE task_id = $1 ORDER BY round", [taskId]);
    return rows.map((r) => ({ round: r.round, state: r.state, signed: r.signed, countersigned: r.countersigned, recorded: r.recorded, createdAt: iso(r.created_at) }));
  }

  async openQuestion(taskId: string, round: number, question: KitQuestion["question"]): Promise<number> {
    const { rows } = await this.db.query("INSERT INTO kit_questions (task_id, round, question) VALUES ($1, $2, $3) RETURNING id", [taskId, round, JSON.stringify(question)]);
    return Number(rows[0].id);
  }

  async resolveQuestion(id: number, status: "answered" | "declined" | "expired", answer?: string): Promise<KitQuestion | undefined> {
    const { rows } = await this.db.query(
      "UPDATE kit_questions SET status = $2, answer = $3, resolved_at = now() WHERE id = $1 AND status = 'open' RETURNING *",
      [id, status, answer ?? null],
    );
    return rows[0] ? this.toQuestion(rows[0]) : undefined;
  }

  async setSuggestion(id: number, suggestion: unknown): Promise<void> {
    await this.db.query("UPDATE kit_questions SET suggestion = $2 WHERE id = $1", [id, JSON.stringify(suggestion)]);
  }

  async questions(status: KitQuestion["status"] | "all" = "open"): Promise<KitQuestion[]> {
    const { rows } = await this.db.query(
      `SELECT q.*, t.capability, t.peer_name FROM kit_questions q JOIN kit_tasks t ON t.id = q.task_id
       ${status === "all" ? "" : "WHERE q.status = $1"} ORDER BY q.created_at DESC LIMIT 100`,
      status === "all" ? [] : [status],
    );
    return rows.map((r) => ({ ...this.toQuestion(r), capability: r.capability, peerName: r.peer_name }));
  }

  private toQuestion(r: Record<string, any>): KitQuestion {
    return { id: Number(r.id), taskId: r.task_id, round: r.round, question: r.question, answer: r.answer, status: r.status, suggestion: r.suggestion ?? null, createdAt: iso(r.created_at) };
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    const { rows } = await this.db.query("SELECT value FROM kit_settings WHERE key = $1", [key]);
    return rows[0]?.value as T | undefined;
  }

  async setSetting(key: string, value: unknown) {
    await this.db.query(
      "INSERT INTO kit_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [key, JSON.stringify(value)],
    );
  }

  async audit(limit = 100): Promise<{ id: number; event: string; details: Record<string, unknown>; createdAt: string }[]> {
    const { rows } = await this.db.query("SELECT * FROM kit_audit ORDER BY id DESC LIMIT $1", [limit]);
    return rows.map((r) => ({ id: Number(r.id), event: r.event, details: r.details, createdAt: iso(r.created_at) }));
  }

  async counts(): Promise<Record<string, number>> {
    const { rows } = await this.db.query(`
      SELECT
        (SELECT count(*) FROM kit_tasks WHERE direction = 'inbound') AS inbound,
        (SELECT count(*) FROM kit_tasks WHERE direction = 'outbound') AS outbound,
        (SELECT count(*) FROM kit_questions WHERE status = 'open') AS open_questions,
        (SELECT count(*) FROM kit_receipts) AS receipts`);
    const r = rows[0];
    return { inbound: Number(r.inbound), outbound: Number(r.outbound), openQuestions: Number(r.open_questions), receipts: Number(r.receipts) };
  }
}

/** The gateway's provider-side task state, in the node's database so tasks survive restarts. */
export class PgTaskStore implements TaskStore {
  constructor(private readonly db: Db) {}

  async get(id: string): Promise<StoredTask | undefined> {
    const { rows } = await this.db.query("SELECT data FROM gateway_tasks WHERE id = $1", [id]);
    return rows[0]?.data as StoredTask | undefined;
  }

  async save(task: StoredTask): Promise<void> {
    await this.db.query(
      "INSERT INTO gateway_tasks (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
      [task.id, JSON.stringify(task)],
    );
  }
}

/** Seen nonces in the node's database, so replicas of one node share replay protection. */
export class PgNonceStore implements NonceStore {
  constructor(private readonly db: Db) {}

  async firstUse(nonce: string, expSeconds: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      "INSERT INTO gateway_nonces (nonce, expires_at) VALUES ($1, to_timestamp($2)) ON CONFLICT (nonce) DO NOTHING",
      [nonce, expSeconds],
    );
    return rowCount === 1;
  }

  /** Expired nonces can no longer be replayed (the envelope would be rejected as expired). */
  async prune(): Promise<number> {
    const { rowCount } = await this.db.query("DELETE FROM gateway_nonces WHERE expires_at < now() - interval '5 minutes'");
    return rowCount ?? 0;
  }
}

export class PgDraftStore implements DraftStore {
  constructor(private readonly db: Db) {}

  async save(draft: DraftOrder): Promise<void> {
    await this.db.query(
      "INSERT INTO kit_drafts (order_ref, data) VALUES ($1, $2) ON CONFLICT (order_ref) DO UPDATE SET data = EXCLUDED.data",
      [draft.orderRef, JSON.stringify(draft)],
    );
  }

  async get(orderRef: string): Promise<DraftOrder | undefined> {
    const { rows } = await this.db.query("SELECT data FROM kit_drafts WHERE order_ref = $1", [orderRef]);
    return rows[0]?.data as DraftOrder | undefined;
  }
}

export class PgAuditSink implements AuditSink {
  constructor(private readonly db: Db) {}

  async write(event: string, details: Record<string, unknown>): Promise<void> {
    await this.db.query("INSERT INTO kit_audit (event, details) VALUES ($1, $2)", [event, JSON.stringify(details)]);
  }
}
