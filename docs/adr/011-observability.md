# ADR 011: Observability

- Status: Accepted
- Date: 2026-10-21

## Context

The spec (§15) defines how the network is judged:
- task completion rate
- p50 and p95 latency
- the share of unauthorized requests blocked
- fields disclosed and withheld
- direct and relayed connections

Until now these could only be reconstructed from audit logs. Operators also had no way to follow one slow or failing task across the platform and their own node. Telemetry is a classic leak path, so the design has to keep it from becoming a side channel for the data the network is built to protect.

## Decision

1. **Prometheus metrics, scraped by whoever owns the process.**
   - **Platform** (`/actuator/prometheus`, Micrometer):
     - `pistiva_grants_total{capability,outcome}`
     - `pistiva_task_rounds_total` and `pistiva_tasks_finished_total{capability,state}`
     - `pistiva_task_duration_seconds` (histogram, first grant → terminal receipt)
     - `pistiva_auth_rejected_total{kind}`
     - `pistiva_tasks_expired_total`
     - `pistiva_webhook_deliveries_total{result}`
     - `pistiva_certifications_total{status}`
   - **Partner Kit** (`/metrics`, prom-client):
     - `pistiva_kit_rounds_total` and `pistiva_kit_tasks_finished_total{direction,capability,state}`
     - `pistiva_kit_task_duration_seconds`
     - `pistiva_kit_fields_total{capability,disposition}`
     - `pistiva_kit_requests_rejected_total{reason}`
     - `pistiva_kit_connections_total{connection}`
     - gauges for background jobs and open questions

   Each business scrapes its own node, so node metrics never leave the organization.
2. **Labels are bounded and carry no business data.**
   - **Capabilities:** a capability label is a registered task type (platform) or one the node provides or requests (node). Anything else becomes `other`, so a caller cannot create series by inventing names.
   - **Other labels:** only states, outcomes and rejection reasons.
   - **Never labels:** ids, SKUs, prices and field values. Tests assert that neither the scrape output nor the spans contain them.
3. **Both endpoints are closed by default.** Each needs a static bearer token (`PISTIVA_METRICS_TOKEN`, `KIT_METRICS_TOKEN`), compared in constant time. A console or agent token does not open the platform's endpoint.
4. **Tracing with OpenTelemetry, exported only when configured.**
   - **Platform:** Micrometer Tracing with the OTel bridge; traces are exported when `MANAGEMENT_OTLP_TRACING_ENDPOINT` is set. Grant and receipt spans carry `pistiva.task_id`.
   - **Gateway:** spans through `@opentelemetry/api` (`pistiva.a2a <method>`), a no-op unless the host registers an SDK. Each span carries:
     - task id, capability and round
     - message kind and resulting state
     - the requester's agent id
     - counts of fields disclosed and withheld
     - the rejection reason
   - **Partner Kit:** registers the Node SDK when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
5. **No trace context crosses organizations.** We don't propagate `traceparent` between a requester's and a provider's systems. A shared trace id would link two businesses' internal telemetry. The task id is already shared and recorded on both sides, so it is the join key: search for `pistiva.task_id` in each side's own tracing.
6. **A local stack in `infra/`.** `infra/observability.yml` layers Prometheus, Grafana and Jaeger over the compose stack. The provisioned dashboard **Pistiva network** shows the §15 measures for the platform and the nodes.

## Consequences

- Latency includes time a task spends waiting for a human answer. That is the latency a buyer experiences, but it makes p95 sensitive to slow operators. A per-round latency can be added if needed.
- Relayed connections show as zero until the P2P/relay work (M2.8) adds them.
- With tracing on but no exporter configured, spans are created and dropped. Deployments without a collector set `PISTIVA_TRACE_SAMPLING=0`, as the Render blueprint does.
