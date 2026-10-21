import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Where a gateway writes its own detailed log. */
export interface AuditSink {
  write(event: string, details: Record<string, unknown>): Promise<void>;
}

/**
 * The provider's own detailed log, kept on its side. It holds hashes, decisions and the
 * names of fields withheld, never the private values themselves.
 */
export class LocalAuditLog implements AuditSink {
  private ready?: Promise<unknown>;

  constructor(private readonly path?: string) {}

  async write(event: string, details: Record<string, unknown>): Promise<void> {
    if (!this.path) return;
    this.ready ??= mkdir(dirname(this.path), { recursive: true });
    await this.ready;
    await appendFile(this.path, JSON.stringify({ ts: new Date().toISOString(), event, ...details }) + "\n");
  }
}
