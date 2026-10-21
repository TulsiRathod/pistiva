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
