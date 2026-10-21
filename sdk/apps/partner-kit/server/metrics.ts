import type { AuditSink } from "@pistiva/gateway";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { JobQueue } from "./jobs.ts";
import type { KitRepo } from "./repo.ts";

type Direction = "inbound" | "outbound";

const TERMINAL = new Set(["completed", "failed", "rejected", "canceled"]);

/**
 * The node's share of the network measures (spec §15), for Prometheus. Each node is scraped by its
 * own business, so nothing leaves the organization. Labels hold bounded values only: capability
 * names this node provides or requests, task states, rejection reasons; never ids or field values.
 */
export class KitMetrics {
  readonly registry = new Registry();
  private readonly rounds: Counter;
  private readonly finished: Counter;
  private readonly duration: Histogram;
  private readonly fields: Counter;
  private readonly rejected: Counter;
  private readonly connections: Counter;

  constructor(
    private readonly capabilities: Set<string>,
    sources: { jobs: JobQueue; repo: KitRepo },
  ) {
    const registers = [this.registry];
    this.rounds = new Counter({ name: "pistiva_kit_rounds_total", help: "Signed task rounds by direction and state", labelNames: ["direction", "capability", "state"], registers });
    this.finished = new Counter({ name: "pistiva_kit_tasks_finished_total", help: "Tasks that reached a terminal state", labelNames: ["direction", "capability", "state"], registers });
    this.duration = new Histogram({
      name: "pistiva_kit_task_duration_seconds",
      help: "Time from a task's first round to its terminal state",
      labelNames: ["direction", "capability", "state"],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900, 3600, 4 * 3600, 25 * 3600],
      registers,
    });
    this.fields = new Counter({ name: "pistiva_kit_fields_total", help: "Result fields this node disclosed or withheld", labelNames: ["capability", "disposition"], registers });
    this.rejected = new Counter({ name: "pistiva_kit_requests_rejected_total", help: "Inbound requests refused before any work (signature, grant, replay, contract)", labelNames: ["reason"], registers });
    this.connections = new Counter({ name: "pistiva_kit_connections_total", help: "Outbound task connections by kind", labelNames: ["connection"], registers });
    new Gauge({
      name: "pistiva_kit_jobs",
      help: "Background jobs created in the last day, by kind and status",
      labelNames: ["kind", "status"],
      registers,
      async collect() {
        this.reset();
        for (const s of await sources.jobs.stats()) this.set({ kind: s.kind, status: s.status }, s.count);
      },
    });
    new Gauge({
      name: "pistiva_kit_open_questions",
      help: "Supplier questions waiting for this node's operator",
      registers,
      async collect() {
        this.set((await sources.repo.counts()).openQuestions ?? 0);
      },
    });
  }

  round(direction: Direction, capability: string, state: string, startedAt?: string): void {
    const labels = { direction, capability: this.known(capability), state };
    this.rounds.inc(labels);
    if (TERMINAL.has(state)) {
      this.finished.inc(labels);
      if (startedAt) this.duration.observe(labels, Math.max(0, (Date.now() - Date.parse(startedAt)) / 1000));
    }
  }

  disclosure(capability: string, disclosed: number, withheld: number): void {
    const cap = this.known(capability);
    if (disclosed) this.fields.inc({ capability: cap, disposition: "disclosed" }, disclosed);
    if (withheld) this.fields.inc({ capability: cap, disposition: "withheld" }, withheld);
  }

  connection(kind: string): void {
    this.connections.inc({ connection: kind === "relayed" ? "relayed" : "direct" });
  }

  /** Counts the gateway's rejections as they are written to the node's audit log. */
  auditSink(inner: AuditSink): AuditSink {
    return {
      write: async (event, details) => {
        if (event === "a2a.rejected" || event === "task.rejected") {
          this.rejected.inc({ reason: String(details.reason ?? details.code ?? "unknown").slice(0, 40) });
        }
        await inner.write(event, details);
      },
    };
  }

  private known(capability: string): string {
    return this.capabilities.has(capability) ? capability : "other";
  }
}
