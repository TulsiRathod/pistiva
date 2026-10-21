# Pistiva — privacy-first business AI agent network

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
  packages/procurement procurement modules (quote.request, order.draft) and inventory connectors
  apps/partner-kit     the self-hosted node per business: gateway + outbox + operator UI + own Postgres
  examples/            supplier-agent (quotes from a private inventory), buyer-agent (compare + decide)
  scripts/demo.ts      end-to-end demo with pass/fail checks; scripts/nodes.ts runs two live nodes
console/    React + Vite admin console: org verification, agents and keys, kill switch, policy, audit
infra/      docker-compose for the whole stack
docs/adr/   architecture decisions 001–006
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
| `cd sdk && npm run nodes -- --check` | Two live Partner Kit nodes against the platform: a quote with a clarification answered through the operator API, countersigned receipts, withheld fields recorded |

## Registering your own agent

1. Generate a key pair locally:
   ```bash
   cd sdk && KEY_PASSPHRASE=... npm run keygen -- ./keys/my-agent.key.json
   ```
2. In the console: register the agent, then paste the printed public key.
3. Start the gateway with `examples/supplier-agent` as a template. It publishes its signed card on start:
   ```bash
   AGENT_ID=… ORG_ID=… KEY_FILE=… KEY_PASSPHRASE=… npm start
   ```

## Partner Kit (a node per business)

Each business runs its own Pistiva node: the gateway that answers other agents, an outbox for requests it sends, an operator UI, and its own Postgres database. See [ADR 006](docs/adr/006-partner-kit.md).

```bash
cd sdk/apps/partner-kit
cp config/agents.example.yaml config/agents.yaml      # choose modules and connectors (JSON, CSV or MCP)
mkdir keys && cp <your agent key file> keys/agent.key.json
AGENT_ID=… ORG_ID=… KEY_PASSPHRASE=… KIT_ADMIN_PASSWORD=… PUBLIC_URL=https://node.example.com \
  docker compose up -d --build                         # node UI on http://localhost:9300
```

To try it locally against your local platform, run `cd sdk && npm run nodes`. It starts a supplier node on :9301 and a buyer node on :9302 (operator password `operator-password`).

## Task-type contracts

`GET /task-types` lists the contracts. `GET /task-types/{name}/versions/{v}` returns one, with self-contained JSON Schemas per message kind. A platform admin can publish a new pack with `POST /task-types/packs`; published versions are immutable. See [ADR 005](docs/adr/005-a2a-with-pistiva-trust-and-task-contracts.md).

## Not in this milestone

- The human approval workflow and `order.confirm` handling (M2.3). Grants above the threshold are already flagged `approvalRequired`.
- LLM agent modules (M2.4)
- WebRTC direct connections with TURN relay fallback
- Usage metering and payouts
- KMS/HSM key custody
- Shared nonce and idempotency stores for multi-replica gateways

See the plan's "Next milestone".
