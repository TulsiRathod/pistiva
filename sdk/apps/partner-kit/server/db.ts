import pg from "pg";

/**
 * The node's own database. Request and response contents live here, inside the business's
 * infrastructure; the platform only ever sees hashes.
 */
const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE gateway_tasks (
        id         TEXT PRIMARY KEY,
        data       JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- One row per task this node took part in, from either side.
      CREATE TABLE kit_tasks (
        id                TEXT PRIMARY KEY,
        direction         TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        peer_agent_id     TEXT NOT NULL,
        peer_name         TEXT,
        capability        TEXT NOT NULL,
        task_type_version INTEGER NOT NULL,
        state             TEXT NOT NULL,
        rounds            INTEGER NOT NULL DEFAULT 0,
        budget            TEXT,
        currency          TEXT,
        approval_required BOOLEAN NOT NULL DEFAULT FALSE,
        summary           TEXT,
        error             TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX kit_tasks_direction ON kit_tasks (direction, updated_at DESC);

      CREATE TABLE kit_messages (
        id         BIGSERIAL PRIMARY KEY,
        task_id    TEXT NOT NULL REFERENCES kit_tasks (id),
        round      INTEGER NOT NULL,
        sender     TEXT NOT NULL CHECK (sender IN ('us', 'peer')),
        kind       TEXT NOT NULL,
        state      TEXT,
        data       JSONB,
        withheld   JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX kit_messages_task ON kit_messages (task_id, id);

      CREATE TABLE kit_receipts (
        task_id        TEXT NOT NULL REFERENCES kit_tasks (id),
        round          INTEGER NOT NULL,
        state          TEXT NOT NULL,
        signed         JSONB NOT NULL,
        countersigned  BOOLEAN NOT NULL DEFAULT FALSE,
        recorded       BOOLEAN NOT NULL DEFAULT FALSE,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (task_id, round)
      );

      -- Clarifying questions a provider asked us, waiting for an operator's answer.
      CREATE TABLE kit_questions (
        id          BIGSERIAL PRIMARY KEY,
        task_id     TEXT NOT NULL REFERENCES kit_tasks (id),
        round       INTEGER NOT NULL,
        question    JSONB NOT NULL,
        answer      TEXT,
        status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'declined', 'expired')),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        resolved_at TIMESTAMPTZ
      );

      CREATE TABLE kit_drafts (
        order_ref TEXT PRIMARY KEY,
        data      JSONB NOT NULL
      );

      CREATE TABLE kit_settings (
        key   TEXT PRIMARY KEY,
        value JSONB NOT NULL
      );

      CREATE TABLE kit_audit (
        id         BIGSERIAL PRIMARY KEY,
        event      TEXT NOT NULL,
        details    JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    version: 2,
    sql: `
      -- Turning a held draft into a confirmed order: one commitment per draft task.
      CREATE TABLE kit_commitments (
        id                BIGSERIAL PRIMARY KEY,
        draft_task_id     TEXT NOT NULL UNIQUE REFERENCES kit_tasks (id),
        provider_agent_id TEXT NOT NULL,
        provider_name     TEXT,
        order_ref         TEXT NOT NULL,
        amount            TEXT NOT NULL,
        currency          TEXT NOT NULL,
        approval_id       TEXT,
        status            TEXT NOT NULL,
        confirm_task_id   TEXT,
        note              TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    version: 3,
    sql: `
      -- Model calls made by this node, for cost reports (nothing about their content).
      CREATE TABLE kit_llm_usage (
        id            BIGSERIAL PRIMARY KEY,
        provider      TEXT NOT NULL,
        model         TEXT NOT NULL,
        prompt_id     TEXT,
        input_tokens  INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        latency_ms    INTEGER NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE kit_questions ADD COLUMN suggestion JSONB;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE kit_jobs (
        id           BIGSERIAL PRIMARY KEY,
        kind         TEXT NOT NULL,
        payload      JSONB NOT NULL DEFAULT '{}',
        unique_key   TEXT,
        status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
        attempts     INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        locked_at    TIMESTAMPTZ,
        last_error   TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at  TIMESTAMPTZ
      );
      CREATE INDEX kit_jobs_due ON kit_jobs (status, run_at);
      CREATE UNIQUE INDEX kit_jobs_unique_pending ON kit_jobs (unique_key) WHERE status IN ('pending', 'running');

      -- What an outbound task needs to resume after a restart: the request and the provider it went to.
      ALTER TABLE kit_tasks ADD COLUMN request JSONB;
      ALTER TABLE kit_tasks ADD COLUMN provider JSONB;
    `,
  },
  {
    version: 5,
    sql: `
      -- Seen request nonces, shared by every replica of this node so a replay is caught on any of them.
      CREATE TABLE gateway_nonces (
        nonce      TEXT PRIMARY KEY,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX gateway_nonces_expiry ON gateway_nonces (expires_at);
    `,
  },
];

export type Db = pg.Pool;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

/** Applies pending migrations in order, each in its own transaction. Safe to run on every start. */
export async function migrate(db: Db): Promise<number[]> {
  await db.query("CREATE TABLE IF NOT EXISTS kit_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const done = new Set((await db.query<{ version: number }>("SELECT version FROM kit_migrations")).rows.map((r) => r.version));
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(m.sql);
      await client.query("INSERT INTO kit_migrations (version) VALUES ($1)", [m.version]);
      await client.query("COMMIT");
      applied.push(m.version);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  return applied;
}
