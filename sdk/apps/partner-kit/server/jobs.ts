import type { Db } from "./db.ts";

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

interface JobRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/** A job left "running" this long belongs to a process that died; it is picked up again. */
const STALE_LOCK_MS = 5 * 60_000;

/**
 * Durable background jobs in the node's own Postgres. Workers claim with FOR UPDATE SKIP LOCKED, so
 * several replicas can share one database; failures retry with exponential backoff; recurring jobs
 * are de-duplicated by key so only one copy is pending at a time.
 */
export class JobQueue {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly timers: NodeJS.Timeout[] = [];
  private polling?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly db: Db, private readonly pollMs = 500) {}

  register(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  async enqueue(kind: string, payload: Record<string, unknown> = {}, opts: { delayMs?: number; uniqueKey?: string; maxAttempts?: number } = {}): Promise<void> {
    await this.db.query(
      `INSERT INTO kit_jobs (kind, payload, unique_key, max_attempts, run_at)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval)
       ON CONFLICT (unique_key) WHERE status IN ('pending', 'running') DO NOTHING`,
      [kind, JSON.stringify(payload), opts.uniqueKey ?? null, opts.maxAttempts ?? 5, String(opts.delayMs ?? 0)],
    );
  }

  /** Runs `kind` every `ms`; at most one pending copy exists across all replicas. */
  every(kind: string, ms: number): void {
    const tick = () => void this.enqueue(kind, {}, { uniqueKey: `recurring:${kind}`, maxAttempts: 1 }).catch(() => undefined);
    tick();
    const t = setInterval(tick, ms);
    t.unref?.();
    this.timers.push(t);
  }

  start(): void {
    this.polling = setInterval(() => void this.drain(), this.pollMs);
    this.polling.unref?.();
  }

  stop(): void {
    clearInterval(this.polling);
    this.timers.forEach(clearInterval);
  }

  /** Runs every due job; returns how many ran. Also used directly by tests. */
  async drain(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let ran = 0;
    try {
      for (;;) {
        const job = await this.claim();
        if (!job) return ran;
        ran++;
        await this.run(job);
      }
    } finally {
      this.busy = false;
    }
  }

  private async claim(): Promise<JobRow | undefined> {
    const { rows } = await this.db.query<JobRow>(
      `UPDATE kit_jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
       WHERE id = (
         SELECT id FROM kit_jobs
         WHERE (status = 'pending' AND run_at <= now())
            OR (status = 'running' AND locked_at < now() - ($1 || ' milliseconds')::interval)
         ORDER BY run_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
       RETURNING id, kind, payload, attempts, max_attempts`,
      [String(STALE_LOCK_MS)],
    );
    return rows[0];
  }

  private async run(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.kind);
    try {
      if (!handler) throw new Error(`No handler for job ${job.kind}`);
      await handler(job.payload);
      await this.db.query("UPDATE kit_jobs SET status = 'done', finished_at = now(), last_error = NULL WHERE id = $1", [job.id]);
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      if (job.attempts >= job.max_attempts) {
        await this.db.query("UPDATE kit_jobs SET status = 'failed', finished_at = now(), last_error = $2 WHERE id = $1", [job.id, message]);
      } else {
        // Exponential backoff: 2s, 4s, 8s, ... capped at 10 minutes.
        const delay = Math.min(2 ** job.attempts * 1000, 600_000);
        await this.db.query(
          "UPDATE kit_jobs SET status = 'pending', locked_at = NULL, last_error = $2, run_at = now() + ($3 || ' milliseconds')::interval WHERE id = $1",
          [job.id, message, String(delay)],
        );
      }
    }
  }

  async stats(): Promise<{ kind: string; status: string; count: number; lastError: string | null }[]> {
    const { rows } = await this.db.query(
      `SELECT kind, status, count(*)::int AS count, max(last_error) AS last_error FROM kit_jobs
       WHERE created_at > now() - interval '1 day' GROUP BY kind, status ORDER BY kind, status`,
    );
    return rows.map((r) => ({ kind: r.kind, status: r.status, count: r.count, lastError: r.last_error }));
  }
}
