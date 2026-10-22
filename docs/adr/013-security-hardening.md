# ADR 013: Security hardening

- Status: Accepted
- Date: 2026-10-22

## Context

A review of the surfaces added in M2.5-M2.8 (webhooks, signaling, metrics, billing, certification) found places where a customer-controlled input or a missing limit could be abused. These are the changes made in response.

## Decision

1. **Webhook URLs cannot reach the platform's network.** A customer chooses the URL, so a webhook could target cloud metadata (169.254.169.254), the database or internal services. `UrlGuard` resolves the host and refuses loopback, link-local, private, carrier-grade-NAT, multicast and unique-local addresses. It runs when the webhook is created and again before every delivery, which also catches a name that later resolves inside the network. `pistiva.webhooks.allow-http` (development only) disables it, because it also permits local test servers. Residual risk: a DNS answer can change between the check and the connection; deployments that need more should send webhooks through an egress proxy.
2. **Password guessing is slowed.** The platform refuses further sign-ins for an email after 10 failures in 15 minutes (HTTP 429), even with the right password; the Partner Kit does the same per source address. Limits are kept in memory per instance, so they bound guessing rather than lock accounts, and with several replicas the effective limit is per replica.
3. **Long polling is capped.** Each agent may hold three long-poll requests and the platform 2000, so signaling cannot be used to exhaust it.
4. **A grant cannot be authorized below the provider's price.** The budget is what the requester approves for the task and the provider's per-task price is charged on completion; a grant whose budget is below the price in the provider's card is denied. Without this a provider could raise its price after buyers had set their limits.
5. **Probe traffic is not billed.** Tasks requested by certifier organizations produce no usage records.
6. **Certification reports need evidence** of the probes (ADR 010).
7. **Separation of duties** can be required for approvals (ADR 007).
8. **Already in place and re-checked:** bearer tokens for metrics compared in constant time and closed by default; CSV exports neutralize formula characters; webhook payloads signed with HMAC and timestamped; agent sessions single-use; SDP signed by the agents so signaling cannot be tampered with by the platform; all SQL parameterized.

## Not covered

- No external penetration test has been done.
- Secrets in environment variables (admin password, Vault token, TURN secret) rely on the hosting platform's secret handling.
- The TURN relay in `infra/turn.yml` is for local use: no TLS, loopback peers allowed.
