# ADR 001: Hybrid architecture — central control plane, customer-run gateways

- Status: Accepted
- Date: 2026-10-21

## Context

Businesses will only automate across company lines if they keep control of their own agents and data (team document §1, §6). A fully central platform would see every payload. A fully decentralized design would have no trusted discovery, no revocation and no simple way to bill.

## Decision

- **The control plane (`platform/`, Spring Boot + PostgreSQL)** owns organization and agent identity, the registry and discovery, policy, task grants, revocation and the audit metadata.
- **Gateways (`sdk/packages/gateway`)** run on each organization's own infrastructure, next to its private systems. A gateway executes tasks and decides what to disclose.
- **Task payloads travel gateway to gateway.** The platform stores only metadata: hashes, signatures and policy decisions.
- **Transport in this milestone is direct HTTPS.** WebRTC with relay fallback comes next. The SDK reports the transport it used (`connection: "direct"`) so that relay can be added without an API change.

## Consequences

- A platform breach exposes metadata, not business data.
- A provider must be reachable from the requester. Behind NAT this needs the relay planned for the next milestone.
- Each gateway caches peer status for a short time (5–30 s). That window is how long a revocation can take to reach a gateway. Grants are checked live at the platform.
