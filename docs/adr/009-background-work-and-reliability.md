# ADR 009: Background work and reliability

- Status: Accepted
- Date: 2026-10-21

## Context

Before this change everything ran inside a request. A Partner Kit restart lost every outbound task that was waiting for an operator's answer. A supplier that accepted a task and never replied left it "working" forever. A receipt the platform refused (because it was down) was never sent again. On the platform, grants of abandoned tasks stayed `ISSUED`, and nothing told a business about events that concern it. Replay protection lived in each process's memory, so two replicas could each accept the same request once.

## Decision

1. **The Partner Kit has a job queue in its own Postgres** (`kit_jobs`), not Redis or a separate broker, so a node stays one app plus one database.
   - Workers claim jobs with `FOR UPDATE SKIP LOCKED`, so several replicas can share the queue.
   - A failed job is retried with backoff `min(2^attempts s, 10 min)` up to `max_attempts`, then marked `failed` with the error.
   - A job locked for more than 5 minutes (its process died) is claimed again.
   - Recurring jobs use a unique key, so only one pending copy of each exists, however many replicas schedule it.
2. **Outbound tasks resume from the database.** The task's request and provider are stored with it. Answering a supplier's question enqueues `outbound.resume`, which asks the platform for a continuation grant (`continueTaskId`) and carries on. A restart between question and answer loses nothing.
3. **Scheduled maintenance on each node:**
   - `questions.expire`: a question unanswered for 24 hours cancels the task at the supplier.
   - `outbound.recover`: a task with no progress for 10 minutes is fetched with `tasks/get`. After an hour with no reply it is marked failed ("The supplier stopped responding").
   - `receipts.resubmit`: receipts the platform has not recorded are sent again.
   - `approvals.poll`: pending human approvals are checked (ADR 007).
   - `nonces.prune`: expired nonces are deleted.
4. **Replay protection is shared.** The gateway takes a `NonceStore`. The Partner Kit passes one backed by its database (`gateway_nonces`, insert-if-absent), so every replica of a node sees the same nonces. The platform's `ReplayStore` is in memory by default and uses Redis (`SET NX` with a TTL) when `PISTIVA_REDIS_URL` is set.
5. **Platform webhooks use a transactional outbox.** An audit event and its `outbox_events` rows are written in the same transaction, one row per subscribed organization. A scheduled dispatcher delivers them:
   - Each POST carries `X-Pistiva-Event`, `X-Pistiva-Delivery`, `X-Pistiva-Timestamp` and `X-Pistiva-Signature: sha256=HMAC(secret, timestamp + "." + body)`.
   - Failures are retried with backoff `min(10·2^attempts s, 1 h)`, up to 10 attempts.
   - Rows are claimed with `SKIP LOCKED`, so platform replicas never deliver the same row concurrently.
   - Endpoints must be HTTPS. The secret is shown once, at creation.
6. **The platform sweeps abandoned tasks.** When all of a task's grants are still `ISSUED`, expired more than 25 hours ago, and the task has no terminal receipt, the grants become `EXPIRED` and `TASK_EXPIRED` is audited (and delivered as a webhook). The 25 hours is longer than a node's 24-hour answer deadline, so a task that is legitimately waiting is never swept.

## Consequences

- Webhook delivery is at least once. Receivers de-duplicate on `X-Pistiva-Delivery` and reject old timestamps.
- The kit's queue is good for a node's volume (tens of jobs a minute). It is not a general-purpose broker.
- The answer to a retried round (same idempotency key) is still cached in process memory, on both the A2A and the legacy route. A retry that reaches a different replica runs the round again. Handlers must therefore stay safe to repeat: `order.confirm` refuses a draft that is already confirmed. A shared reply cache can come later.
- Redis is optional everywhere. Without it, a platform running several replicas can accept a replayed agent assertion once per replica within its short TTL (2 minutes).
