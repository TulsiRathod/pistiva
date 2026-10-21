import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

/**
 * Starts OpenTelemetry tracing when OTEL_EXPORTER_OTLP_ENDPOINT (or the traces-specific variable) is
 * set, so the gateway's spans reach the business's own collector. Spans carry task ids, states and
 * counts only. Nothing is sent anywhere by default.
 */
export function startTracing(serviceName: string): NodeSDK | undefined {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT && !process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return undefined;
  const sdk = new NodeSDK({ serviceName: process.env.OTEL_SERVICE_NAME ?? serviceName, traceExporter: new OTLPTraceExporter() });
  sdk.start();
  return sdk;
}
