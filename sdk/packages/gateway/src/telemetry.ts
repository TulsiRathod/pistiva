import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";

/**
 * Tracing for the gateway through the OpenTelemetry API. It is a no-op until the host app
 * registers an SDK (the Partner Kit does when OTEL_EXPORTER_OTLP_ENDPOINT is set).
 * Spans carry identifiers, states and counts only: never message contents, field values or keys.
 */
export const tracer = trace.getTracer("@pistiva/gateway");

export const SpanAttr = {
  taskId: "pistiva.task_id",
  capability: "pistiva.capability",
  round: "pistiva.round",
  kind: "pistiva.message_kind",
  state: "pistiva.task_state",
  requesterAgent: "pistiva.requester_agent_id",
  fieldsDisclosed: "pistiva.fields_disclosed",
  fieldsWithheld: "pistiva.fields_withheld",
  rejection: "pistiva.rejection",
  rpcMethod: "rpc.method",
} as const;

/** Runs fn inside an active span; errors mark the span and are rethrown. */
export async function inSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Adds attributes to the span of the current request, if any. */
export function annotate(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}
