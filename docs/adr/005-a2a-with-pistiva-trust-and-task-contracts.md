# ADR 005: A2A on the wire, pistiva-trust extension, task-type contracts

- Status: Accepted
- Date: 2026-10-21

## Context

Milestone 1 used our own envelope over HTTPS, so outside agent ecosystems couldn't talk to us without an adapter. The AtOM reference architecture shows two more things we lacked:
- a shared **task-type contract**, so both sides agree on message shapes
- **multi-round exchanges**, so a provider can ask a question instead of guessing

## Decision

1. **The gateway speaks A2A 0.3 over JSON-RPC.**
   - `POST /a2a` handles `message/send`, `tasks/get` and `tasks/cancel`. `message/stream` returns *unsupported operation* for now.
   - `GET /.well-known/agent-card.json` serves a standard A2A agent card. Its skills are named `<task type>@<version>`.
   - The milestone-1 route `/pistiva/v1/tasks` keeps working for single-round tasks while requesters migrate.

2. **The `pistiva-trust` extension is required on our network.** Its URI is `https://pistiva.ai/a2a/ext/pistiva-trust/v1`, and the agent card declares it as `required`.
   - **Message metadata (requester to provider)** carries `{header, signature}`. That's our envelope header (with the grant, nonce, idempotency key, `kind` and `round`) plus a signature over `canonical({header, body: message.parts})`.
   - **Task metadata (provider to requester)** carries `{header, signature, receipt}`. That's the provider's signature over `canonical({header, body: {state, parts}})` for this round, plus the round's receipt.
   - **The agent card extension params** carry the signed registry card, so a peer can verify the card without asking the platform.
   - `tasks/get` and `tasks/cancel` need a `pistiva-agent+jwt` bearer assertion whose `aud` is the provider. Only the task's requester can read or cancel it; anyone else gets *task not found*.

3. **Task-type contracts live in the platform registry** (`/task-types`).
   - A contract version names:
     - a direction: `requester_to_provider` or `provider_to_requester`
     - a cardinality: `one_to_one` or `one_to_many`
     - a handler
     - self-contained JSON Schema 2020-12 documents for the `request`, `result`, and optionally `clarification`/`answer` messages
   - **Published versions are immutable.** A change is a new version.
   - **Domain packs share a vocabulary** through `$defs`. The bundled pack is `procurement`: `quote.request`, `order.draft`, `order.confirm`, and `delivery.update`, which is marked as an extension.
   - Cards may only advertise registered versions, and grants pin one (`ttv`).
   - **Gateways validate every incoming message**, and their own outgoing results, against the contract. A result that breaks the contract fails the task instead of being sent.

4. **Multi-turn tasks follow the A2A states.** A provider returns `input-required` with a `clarification`. The requester replies with an `answer` message on the same task id (round + 1).
   - **Every round has its own signed and countersigned receipt.** The platform stores one row per `(task, round)` and refuses new rounds after a terminal state.
   - **A long task can be renewed** with `POST /grants {continueTaskId}`. The renewal can't change the provider or capability, and can't raise the budget.

## Consequences

- Any A2A client can discover our agents and read their cards. Only clients that implement pistiva-trust can get work done, and that's intended.
- Cancellation isn't a signed round, so a canceled task has no terminal receipt on the platform. Platform-side task expiry (M2.5) will close such tasks.
- We implemented the A2A types ourselves rather than adopting `@a2a-js/sdk`. The signature scheme is tied to message parts, and a small, typed subset was simpler to keep exact. We'll revisit when we add streaming.
