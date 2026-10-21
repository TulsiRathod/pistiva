# ADR 004: No blockchain in the MVP

- Status: Accepted
- Date: 2026-10-21

## Context

The team document (§9) allows a ledger only where independent parties need a shared, tamper-evident record. It also says business data, prices, prompts and personal data must never go on-chain.

## Decision

The MVP uses **receipts signed by both parties**, with their hashes recorded in an ordinary PostgreSQL audit log:

- Each party keeps the full receipt and its own detailed log (the gateway's `LocalAuditLog`).
- The platform stores the request and response hashes, both signatures and both key ids.

There is no ledger, token or on-chain settlement.

## Revisit when

A design partner shows a concrete need to verify records across organizations independently of the platform. The next step would then be to **anchor hashes of audit bundles**, not to move data or payments on-chain.
