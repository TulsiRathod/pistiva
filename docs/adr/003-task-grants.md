# ADR 003: Platform-issued task grants and two-layer policy

- Status: Accepted
- Date: 2026-10-21

## Context

A provider must be able to tell that a request is authorized without calling the platform for every message. The platform must still be the place where spending and scope rules are enforced and audited.

## Decision

1. **Before every task, the requester calls `POST /grants`.** The platform checks its rules deterministically:
   - both organizations are verified and active
   - neither agent is suspended
   - the provider advertises the capability
   - the requester's policy allows the capability
   - the budget is within the per-task cap
   - the requester is within its rate limit

   It records `GRANT_ISSUED` or `GRANT_DENIED`, with the reason, in the audit log.
2. **A grant is a 5-minute `pistiva-grant+jwt` signed by the platform.** It names exactly:
   - one requester (`sub`) and one provider (`aud`)
   - the task (`tid`) and capability (`cap`)
   - the budget (`bud`, `cur`)
   - whether human approval is required (`apr`)
   - the response fields the provider may disclose (`fld`)
3. **The provider's gateway verifies the grant offline against `/.well-known/jwks.json`** and checks that it matches the signed envelope. It then applies its **local** policy: it must offer the capability, the input must pass validation, and the response is stripped to the local allowlist ∩ `fld`.
4. **Replay and retry are handled separately:**
   - Replay protection uses a per-sender nonce.
   - Retries are re-signed with a fresh nonce but reuse the task's `idempotencyKey`. The provider returns the cached response, so the work happens at most once.
   - Reusing an idempotency key with a different body is rejected with 409.
5. **No language-model output takes part in any of these decisions.**

## Consequences

- Purchases above the approval threshold are flagged (`apr: true`) but cannot be committed in this milestone. The approval workflow comes next.
- Nonce and idempotency stores are in memory. A gateway that runs more than one replica needs a shared store.
- The rate limiter is a per-agent token bucket stored in Postgres, so Redis isn't needed yet.
