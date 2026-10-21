# Pistiva â€” privacy-first business AI agent network

This is the network described in the team document (v1.0, 21 Oct 2026). Milestone 1 delivered identity, registry, messaging and policy. Milestone 2.1 adds the **A2A protocol**, **task-type contracts** and **multi-turn tasks**. Independently run buyer and supplier agents:
- discover each other
- obtain a platform-signed task grant pinned to a contract version
- talk **A2A JSON-RPC directly, gateway to gateway**, with the `pistiva-trust` extension carrying signatures, grants and receipts
- go through clarification rounds when a supplier needs more information
- countersign a receipt for every round that both sides and the platform can verify

The platform never sees task payloads.

```
platform/   Spring Boot 3 / Java 21 control plane: orgs, agents, keys, signed cards, discovery,
            task-type registry + domain packs, policy, grants, JWKS, per-round receipts, audit
            (PostgreSQL + Flyway; packs in src/main/resources/domain-packs/)
sdk/        TypeScript workspace
  packages/agent-sdk   keys, RFC 8785 canonical JSON, JWS, envelopes, grants, receipts, A2A types,
                       ContractRegistry (AJV), PlatformClient, A2AClient (requester side, multi-turn)
  packages/gateway     provider gateway (Fastify): A2A JSON-RPC + agent card, contract validation,
                       replay/idempotency, local allowlist, per-round signed receipts
  packages/procurement procurement modules (quote.request, order.draft, order.confirm) and inventory connectors
  packages/llm         LLM router (Claude API, Ollama), versioned prompts, agent modules, hybrid RAG, evals
  apps/partner-kit     the self-hosted node per business: gateway + outbox + operator UI + own Postgres
  examples/            supplier-agent (quotes from a private inventory), buyer-agent (compare + decide)
  scripts/demo.ts      end-to-end demo with pass/fail checks; scripts/nodes.ts runs two live nodes
console/    React + Vite console: landing page, org verification, agents and keys, kill switch, approvals,
            policy, audit, platform admin dashboard
infra/      docker-compose for the whole stack
docs/adr/   architecture decisions 001â€“008
```

## Run it

You need Docker, Java 21 with Maven 3.9, and Node 24.

```bash
# Everything in containers
docker compose -f infra/docker-compose.yml up -d --build      # postgres, platform :8080, console :5173
docker compose -f infra/docker-compose.yml run --rm demo      # end-to-end demo

# Or develop locally
docker compose -f infra/docker-compose.yml up -d postgres
cd platform && mvn spring-boot:run                            # http://localhost:8080 (Swagger at /swagger-ui.html)
cd sdk && npm install && npm run demo
cd console && npm install && npm run dev                      # http://localhost:5173
```

The default platform admin is `admin@pistiva.local` / `change-me-admin`. Override it with `PISTIVA_ADMIN_EMAIL` and `PISTIVA_ADMIN_PASSWORD`. Admins can verify organizations manually. Everyone else verifies with a DNS TXT record.

## Tests

| Command | What it covers |
|---|---|
| `cd platform && mvn verify` | Crypto vectors shared with the SDK, plus Testcontainers flow tests: discovery filters unverified orgs, a bad card signature is rejected, out-of-scope and over-budget grants are denied and audited, the approval flag is set above the threshold, a suspended agent or revoked key is blocked, assertion replay is rejected, a receipt needs both valid signatures. Also: the domain pack is registered, published contracts are immutable, cards must name registered versions, grants pin the version and continue without a budget increase, and receipts are recorded per round until the task is terminal |
| `cd sdk && npm test` | Legacy route: bad signature, replay, expired or wrongly addressed grant, out-of-scope capability, revoked key, suspended requester, field allowlist, idempotent retry. A2A: agent card with signed pistiva-trust card, single-round and clarification tasks with per-round receipts, cancel and owner-only `tasks/get`, missing extension, contract violations in and out, cached retries, version pinning |
| `cd sdk && npm run demo` | Live end-to-end run against the platform. Exits non-zero if any check fails |
| `cd sdk && npm run eval -- --self-test` | Agent-module golden set (including prompt-injection cases) through the graders, without a model. `PISTIVA_LLM=anthropic` or `PISTIVA_LLM=ollama` evaluates a real model |
| `cd sdk && npm run nodes -- --check` | Two live Partner Kit nodes against the platform: a quote with a clarification answered through the operator API, countersigned receipts, withheld fields recorded |

## Registering your own agent

1. Generate a key pair locally:
   ```bash
   cd sdk && KEY_PASSPHRASE=... npm run keygen -- ./keys/my-agent.key.json
   ```
2. In the console: register the agent, then paste the printed public key.
3. Start the gateway with `examples/supplier-agent` as a template. It publishes its signed card on start:
   ```bash
   AGENT_ID=â€¦ ORG_ID=â€¦ KEY_FILE=â€¦ KEY_PASSPHRASE=â€¦ npm start
   ```

## Partner Kit (a node per business)

Each business runs its own Pistiva node: the gateway that answers other agents, an outbox for requests it sends, an operator UI, and its own Postgres database. See [ADR 006](docs/adr/006-partner-kit.md).

```bash
cd sdk/apps/partner-kit
cp config/agents.example.yaml config/agents.yaml      # choose modules and connectors (JSON, CSV or MCP)
mkdir keys && cp <your agent key file> keys/agent.key.json
AGENT_ID=â€¦ ORG_ID=â€¦ KEY_PASSPHRASE=â€¦ KIT_ADMIN_PASSWORD=â€¦ PUBLIC_URL=https://node.example.com \
  docker compose up -d --build                         # node UI on http://localhost:9300
```

To try it locally against your local platform, run `cd sdk && npm run nodes`. It starts a supplier node on :9301 and a buyer node on :9302 (operator password `operator-password`).

## AI assistance

Each node can turn on an AI layer in `agents.yaml`, using the Claude API, a local Ollama model, or none. See [ADR 008](docs/adr/008-ai-layer.md).
- **Buyer side:** turns a description into a quote request for the operator to review, and suggests answers to suppliers' questions.
- **Supplier side:** offers "did you meanâ€¦" alternatives from its own catalog (hybrid pgvector search), and asks before quoting items that conflict with a buyer's specs.

Models only draft and ask. Grants, contracts and disclosure rules decide everything, so turning AI on never changes what can be committed or disclosed.

## Human approvals

A purchase above your organization's approval threshold can't be committed until a person approves it. See [ADR 007](docs/adr/007-human-approvals.md).

1. A buyer node's operator clicks **Commit order** on a held draft.
2. The platform answers `approval_required`, and the node files an approval request.
3. An owner, admin or approver decides it under **Approvals** in the console.
4. The node confirms with the supplier automatically. Each approval backs exactly one commitment.

## Reliability and webhooks

See [ADR 009](docs/adr/009-background-work-and-reliability.md).
- **Partner Kit:** a Postgres-backed job queue resumes tasks after restarts and retries with backoff. It cancels tasks whose questions go unanswered for 24 hours, recovers tasks from suppliers that went silent, and re-sends receipts the platform refused. `GET /ui/jobs` shows the queue. Replicas of one node share replay protection through its database.
- **Platform:** `POST /orgs/{orgId}/webhooks` with `{ "url": "https://â€¦", "events": ["GRANT_ISSUED", "TASK_EXPIRED"] }` subscribes to events. `GET /webhooks/event-types` lists them, and `*` subscribes to all. Each delivery is signed with `X-Pistiva-Signature: sha256=HMAC(secret, timestamp + "." + body)`. The secret is returned only when the webhook is created, and deliveries are retried for up to 10 attempts. Abandoned tasks are expired after 25 hours.
- **Multiple platform replicas:** set `PISTIVA_REDIS_URL` (for example `redis://redis:6379`) to share replay protection between them.

## Partner certification

A conformance suite checks that a partner's agent keeps the protocol's promises before buyers rely on it. See [ADR 010](docs/adr/010-partner-certification.md). It checks:
- the signed A2A card
- that unsigned, tampered, expired, replayed and out-of-scope messages are rejected
- that requests and results follow the contract
- that only granted fields are disclosed
- signed receipts and idempotent retries

```bash
cd sdk
# Self-test before applying; nothing is recorded.
CERTIFIER_AGENT_ID=<another of your agents> CERTIFIER_KEY_FILE=<its key file> KEY_PASSPHRASE=â€¦   npm run certify -- --agent <agent to test> --capability quote.request --sample '{"sku":"NUT-M8","qty":100}'
# A certifier records the result (its organization is marked as certifier by a platform admin).
npm run certify -- --agent <agent> --submit
```

Discovery marks each agent `certified` and accepts `certifiedOnly=true`. With `PISTIVA_CERTIFICATION_REQUIRED=true` (`pistiva.certification.required`), buyers only see certified agents and the platform refuses grants to uncertified ones. Certification lasts 365 days, and the latest run decides. Admins revoke certifications and designate certifiers from the console's Admin page.

## Observability

Prometheus metrics and OpenTelemetry traces cover the network measures in the spec (§15):
- task completion rate
- p50 and p95 task latency
- the share of unauthorized requests blocked
- fields disclosed and withheld
- direct and relayed connections

Metrics labels and span attributes hold only bounded values and ids: never field values or message contents. See [ADR 011](docs/adr/011-observability.md).

```bash
docker compose -f infra/docker-compose.yml -f infra/observability.yml up --build
cd sdk && npm run demo        # some traffic; `npm run nodes` adds two scraped Partner Kit nodes
```

Grafana at http://localhost:3000 (admin / admin) has the **Pistiva network** dashboard. Prometheus is at :9090 and Jaeger at :16686.
- **Platform:** `GET /actuator/prometheus` needs `Authorization: Bearer $PISTIVA_METRICS_TOKEN` and is closed without it. Traces are exported when `MANAGEMENT_OTLP_TRACING_ENDPOINT` is set.
- **Partner Kit:** `GET /metrics` needs `Authorization: Bearer $KIT_METRICS_TOKEN`. Traces are exported when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

## Platform signing key

Grants and console tokens are signed with the platform's Ed25519 key. By default the key comes from `PISTIVA_SIGNING_KEY_SEED`, or from a generated development file. For production, keep it in Vault or OpenBao Transit, optionally HSM-backed, so the private key never leaves the key store:

```bash
vault secrets enable transit && vault write -f transit/keys/pistiva-platform type=ed25519
PISTIVA_SIGNING_PROVIDER=vault-transit VAULT_ADDR=https://vault:8200 VAULT_TOKEN=… java -jar platform.jar
```

Rotating the key with `vault write -f transit/keys/pistiva-platform/rotate` switches new signatures to the new version. Every version stays in `/.well-known/jwks.json`, so outstanding grants keep verifying.

## Task-type contracts

`GET /task-types` lists the contracts. `GET /task-types/{name}/versions/{v}` returns one, with self-contained JSON Schemas per message kind. A platform admin can publish a new pack with `POST /task-types/packs`; published versions are immutable. See [ADR 005](docs/adr/005-a2a-with-pistiva-trust-and-task-contracts.md).

## Not in this milestone

- WebRTC direct connections with TURN relay fallback
- Usage metering and payouts

See the plan's "Next milestone".
