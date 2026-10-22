# ADR 010: Partner certification

- Status: Accepted
- Date: 2026-10-21

## Context

Any verified organization can publish an agent. Verification proves who runs it, not that it keeps the protocol's promises: rejecting replays and expired or out-of-scope messages, honoring the contract, disclosing only granted fields, signing receipts, and executing a retried round once. A partner that gets these wrong puts the other side at risk, even when its own operators mean well. AtOM certifies each partner before it joins. We need the same, without the platform ever seeing task contents.

## Decision

1. **A conformance suite probes the partner the way a buyer would.** `@pistiva/certify` (CLI `pistiva-certify`) runs 14 checks for one capability against the agent's real A2A endpoint. Every probe uses a real grant issued to a certifier's agent.

   | Check | What fails it |
   |---|---|
   | `card.a2a` | No A2A card, wrong transport or URL, or the skill `name@version` is missing |
   | `card.trust-extension` | pistiva-trust is not required, or the served card is not the one signed and registered on the platform |
   | `trust.requires-extension`, `trust.bad-signature`, `trust.expired`, `trust.grant-scope` | An unsigned, tampered, expired or out-of-scope message is accepted |
   | `trust.replay` | The same signed message is answered twice |
   | `trust.task-access` | `tasks/get` works without the requester's assertion, or not with it |
   | `receipts.signed`, `receipts.countersign` | The reply or receipt does not verify or does not match the exchange, or a countersigned receipt is refused |
   | `contract.rejects-invalid`, `contract.result` | A schema-violating request is accepted, or the sample task does not complete with a contract-valid result |
   | `disclosure.grant-fields` | The result contains fields outside the grant's `fld` and the contract |
   | `idempotency.retry` | A retried round is executed again, or a reused key with a different body is accepted |

   The partner chooses a sample request it can complete; `quote.request` has a default. Tasks left waiting are canceled.
2. **Certifiers are organizations an admin designates** (`PUT /admin/organizations/{id}/certifier`). Only their agents may `POST /certifications`, and never for their own organization.
   - The platform recomputes the verdict from the checks. A report cannot claim to pass with a failing check.
   - It stores the report's hash and audits `AGENT_CERTIFIED` or `CERTIFICATION_FAILED`, which also reach the partner as webhooks.
   - Partners run the CLI without `--submit` to test themselves; nothing is recorded.
3. **Status is per agent and task-type version, and the latest run decides.**
   - A certification is valid when it passed, has not expired (`pistiva.certification.validity`, default 365 days) and has not been revoked.
   - A failed re-run replaces an earlier pass.
   - A new contract version needs its own certification.
   - Admins revoke with a reason (`CERTIFICATION_REVOKED`).
4. **Enforcement is a network setting** (`pistiva.certification.required`, default off for pilots).
   - Discovery always reports `certified` and accepts `certifiedOnly=true`.
   - When certification is required:
     - discovery hides uncertified agents
     - the platform refuses grants to them (`Provider is not certified for …`)
   - Certifier organizations and platform admins are exempt, otherwise nobody could certify a new partner.
5. **The console shows it.**
   - Each agent page lists its certifications.
   - The admin dashboard lists results across the network, lets admins revoke them and designate certifiers, and shows certification events in the activity feed.

## Consequences

- The suite proves behavior at one moment, not forever. Expiry forces periodic re-runs, and revocation covers incidents in between.
- The platform trusts the certifier's report, but not blindly. It does not re-run the probes, because doing so would put real task data through the control plane. It does require evidence the probes happened: the report must carry the time the suite started (within the last hour), and the platform must have issued at least `pistiva.certification.min-probe-grants` (default 5) grants from the certifier's agent to the tested agent since then. A report fabricated without running the suite has no such grants behind it. Choosing certifiers is still an admin decision, and every result is audited with its hash.
- Tasks requested by a certifier organization are not billed, so probing a priced provider costs the certifier nothing. The suite's default budget is the provider's advertised price, since the platform refuses a grant whose budget is below it.
- The probes are real tasks: they consume grants and count against the certifier's rate limit and the partner's audit log. With the default `1.00 INR` budget they never cross an approval threshold.
- A gateway built on `@pistiva/gateway` passes out of the box. The suite matters most for partners that implement the protocol themselves.
