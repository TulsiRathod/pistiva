# Operations runbook

For whoever runs a Pistiva platform or a Partner Kit node. Commands assume the compose stack; adapt the connection details to your hosting.

## What holds state

| Component | State | Loss means |
|---|---|---|
| Platform Postgres | organizations, agents, keys (public), cards, policies, grants, receipts (hashes and signatures), audit log, approvals, webhooks, usage, payouts, certifications | Identity and the audit trail are gone. **Back this up.** |
| Platform signing key | Ed25519 private key (seed, file, or Vault Transit) | Every outstanding grant and console session stops verifying. Agents must re-request grants; users sign in again. No data is lost. |
| Partner Kit Postgres | tasks, messages, receipts held by the business, questions, commitments, job queue, nonces, replies to retried rounds | The business loses its own records of what it exchanged. **Back this up.** |
| Partner Kit key file | the agent's Ed25519 private key | The agent cannot sign. Register a new key and revoke the old one. |
| Redis (optional) | replay-protection entries with a TTL of minutes | Nothing durable. Safe to lose. |

The platform never holds task payloads, so restoring it never restores business data.

## Backups

- **Platform database.** Daily `pg_dump -Fc` plus WAL archiving (or your provider's point-in-time recovery) so the audit log can be restored to a few minutes ago.
  ```bash
  pg_dump -Fc -h "$DB_HOST" -U "$DB_USER" pistiva > pistiva-$(date +%F).dump
  ```
- **Signing key.**
  - Vault Transit: back up Vault itself (snapshots, with the unseal keys held separately). Do not set `exportable` on the key.
  - Local seed: store `PISTIVA_SIGNING_KEY_SEED` in your secret manager. The seed alone recreates the key; there is no other copy of it.
- **Partner Kit.** The same `pg_dump` for the node's database, and the encrypted key file with its passphrase stored somewhere other than the file's own disk.
- Test a restore into a scratch database every quarter: restore, start the platform against it, run `npm run demo`.

## Restore

1. Provision Postgres and restore the dump (`pg_restore -d pistiva --clean --if-exists`).
2. Provide the **same signing key** (same seed or the same Vault key). With a different key everything still works, but every previously issued grant fails verification and agents fetch the new key from `/.well-known/jwks.json` on their next request.
3. Start the platform. Flyway applies any newer migrations; it never edits earlier ones.
4. Check `GET /actuator/health`, sign in as the admin, and open the admin dashboard.
5. Webhook deliveries that were pending at the time of the backup resume. Receivers must already deduplicate on `X-Pistiva-Delivery`.

## Key rotation

- **Platform key in Vault:** `vault write -f transit/keys/pistiva-platform/rotate`. New signatures use the new version within five minutes; old versions stay in the JWKS, so nothing breaks. Plan to retire old versions only after the longest-lived grant and token have expired (user tokens last 8 hours).
- **Platform key as a seed:** changing the seed invalidates everything at once. Do it during a quiet window.
- **An agent's key:** add the new public key (`POST /agents/{id}/keys`), switch the node to it, then revoke the old one (`DELETE /agents/{id}/keys/{kid}`). Revocation takes effect on peers within their status cache (30 s by default).
- **Webhook secrets, metrics tokens, TURN secret, Vault token:** replace in the secret manager and restart. A new webhook secret means deleting and recreating the webhook.

## Incidents

| Situation | Action |
|---|---|
| An agent misbehaves or its key leaked | Console → Agents → **Suspend agent**, then revoke the key. Peers stop accepting it within the status cache. |
| An organization is abusive | Admin dashboard → Organizations → **Suspend**. Its agents lose discovery, grants and signaling. |
| A certified partner turns out non-conforming | Admin dashboard → Certifications → **Revoke** with a reason. Revocation is audited and delivered as a webhook. |
| The platform database is unreachable | Agents cannot get grants. Providers keep answering tasks that already have a valid grant until it expires (5 minutes). Receipts are re-sent by each node once the platform returns. |
| A platform replica or node restarts mid-task | Nothing to do. Waiting tasks resume from the database; the node's job queue retries. |
| Webhook endpoint down | Deliveries retry for 10 attempts with backoff; the console shows each delivery. Fix the endpoint, then recreate the webhook if attempts ran out. |
| Suspected replay or forged traffic | Look at `pistiva_auth_rejected_total`, `pistiva_kit_requests_rejected_total{reason}` and the audit log (`a2a.rejected`). Rejections are expected; a spike is the signal. |

## Alerts worth setting (Prometheus)

- Task completion rate below 90% over 1 hour: `sum(increase(pistiva_tasks_finished_total{state="completed"}[1h])) / sum(increase(pistiva_tasks_finished_total[1h])) < 0.9`
- Webhooks failing: `sum(rate(pistiva_webhook_deliveries_total{result="failed"}[10m])) > 0` for 30 minutes
- Auth rejections spike: `sum(rate(pistiva_auth_rejected_total[5m])) > 1`
- A node's jobs failing: `pistiva_kit_jobs{status="failed"} > 0`
- Operator questions piling up: `pistiva_kit_open_questions > 20`
- Platform down: `up{job="pistiva-platform"} == 0`

## Upgrades

- Migrations run at startup and are forward-only. Take a backup first; roll back by restoring it.
- Roll platform replicas one at a time. Grants and receipts are in the database, so replicas are interchangeable.
- Upgrade the platform before the nodes: nodes tolerate a newer platform, and the platform keeps accepting the previous A2A and receipt formats.

## Before production

- Run coturn on a public host with TLS and a real `--external-ip`; remove `--allow-loopback-peers`.
- Put `PISTIVA_SIGNING_PROVIDER=vault-transit` behind a Vault policy that allows only `transit/sign/<key>` and `transit/keys/<key>` read.
- Replace the generated admin password and set `PISTIVA_METRICS_TOKEN`.
- Decide whether `PISTIVA_CERTIFICATION_REQUIRED` should be on, and who your certifier organizations are.
