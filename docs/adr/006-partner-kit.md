# ADR 006: The Partner Kit — a self-hosted node per business

- Status: Accepted
- Date: 2026-10-21

## Context

Until now, a business joining the network needed to write code: the SDK and gateway were libraries, and the examples were scripts. The AtOM reference architecture ships a full Partner Platform that each partner forks and hosts, with its own UI, backend and database, and meets the authority platform only at the A2A boundary.

## Decision

**Ship `sdk/apps/partner-kit`: one deployable node per business.** It contains:
- **The provider gateway** from ADR 001/005, with every A2A round recorded in the node's own Postgres. That covers the request, the reply, the fields withheld and the receipts. Task state survives restarts.
- **An outbound requester.** Each request runs in the background. When a supplier asks a clarifying question, the task waits for a human operator to answer it in the UI. Unanswered questions expire after 24 hours and the task is canceled.
- **`config/agents.yaml`**, which declares the connectors, the task types the node answers and the module for each, and the task types operators may request. Swapping a module is a one-line change.
- **Connectors** to the business's own data:
  - JSON file
  - CSV file
  - **MCP**: any MCP server exposing a lookup tool, run locally over stdio, so ERP data and credentials stay on the business's machines
- **Disclosure settings.** For each answered task type the operator picks which result fields may leave the business. The choice can only narrow the contract's result schema, applies from the next round without a restart, and is persisted.
- **An operator UI**:
  - overview
  - inbox and outbox, with a message thread and receipts per task
  - questions
  - disclosure and data sources
  - the node's own log

  The UI is served by the node and protected by an operator password.

The procurement modules and inventory connectors moved to `@pistiva/procurement`, so the examples and the Partner Kit run the same code.

Packaging: a Dockerfile and a per-business `docker-compose.yml` with its own `pgvector` database (ready for M2.4). Nothing is deployed by the platform.

## Consequences

- Request and response contents now persist, but only in each business's own database. The platform still sees only hashes.
- Clarification waits are held in process memory. After a restart, open questions are marked expired because the task waiting on them is gone. Durable background jobs (M2.5) will resume them instead.
- Operator auth is one shared password per node. SSO can replace it without changing the API.
- Discovery can return agents whose nodes are offline. Such tasks fail cleanly and are recorded as failed, but liveness isn't known in advance. Certification (M2.6) and health signals will improve this.
