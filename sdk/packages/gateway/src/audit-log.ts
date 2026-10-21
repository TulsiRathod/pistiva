import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The provider's own detailed log, kept on its side. It holds hashes, decisions and the
 * names of fields withheld, never the private values themselves.
 */
export class LocalAuditLog {
  private ready?: Promise<unknown>;

  constructor(private readonly path?: string) {}

  async write(event: string, details: Record<string, unknown>): Promise<void> {
    if (!this.path) return;
    this.ready ??= mkdir(dirname(this.path), { recursive: true });
    await this.ready;
    await appendFile(this.path, JSON.stringify({ ts: new Date().toISOString(), event, ...details }) + "\n");
  }
}
