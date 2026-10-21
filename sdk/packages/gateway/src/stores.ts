import type { A2ATask, TaskResponse } from "@pistiva/agent-sdk";

/**
 * Remembers nonces until they expire. A gateway running several replicas passes a shared store
 * (its database or Redis) so a request replayed against another replica is still caught.
 */
export interface NonceStore {
  /** True the first time a nonce is seen; false on replay. */
  firstUse(nonce: string, expSeconds: number): boolean | Promise<boolean>;
}

/**
 * In-memory stores for a single gateway process. A gateway running several replicas needs a
 * shared store (Redis or its own database) for both.
 */
export class NonceCache implements NonceStore {
  private readonly seen = new Map<string, number>();

  /** True the first time a nonce is seen; false on replay. */
  firstUse(nonce: string, expSeconds: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    if (this.seen.size > 10_000) {
      for (const [n, exp] of this.seen) if (exp < now) this.seen.delete(n);
    }
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, expSeconds);
    return true;
  }
}

interface IdempotencyEntry {
  bodyHash: string;
  response: Promise<TaskResponse>;
  until: number;
}

/**
 * Remembers the outcome for (requester, task, idempotency key). A retry gets the original response,
 * so the work is done at most once; concurrent retries wait on the same in-flight promise.
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();

  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000) {}

  get(key: string): IdempotencyEntry | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.until < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  put(key: string, bodyHash: string, response: Promise<TaskResponse>): void {
    this.entries.set(key, { bodyHash, response, until: Date.now() + this.ttlMs });
    // A failed attempt must not be cached, or the requester could never retry it.
    response.catch(() => this.entries.delete(key));
  }
}

/** Provider-side state of one A2A task. Persisted so a task survives a gateway restart. */
export interface StoredTask {
  id: string;
  requesterAgentId: string;
  requesterOrgId: string;
  capability: string;
  taskTypeVersion: number;
  round: number;
  state: A2ATask["status"]["state"];
  /** Handler scratch space carried between rounds; never sent to the requester. */
  memory: Record<string, unknown>;
  /** The latest signed reply; absent only while the first round is running. */
  task?: A2ATask;
}

export interface TaskStore {
  get(id: string): Promise<StoredTask | undefined>;
  save(task: StoredTask): Promise<void>;
}

export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, StoredTask>();

  async get(id: string) {
    const t = this.tasks.get(id);
    return t && structuredClone(t);
  }

  async save(task: StoredTask) {
    this.tasks.set(task.id, structuredClone(task));
  }
}