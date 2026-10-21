-- Organization webhooks, fed by a transactional outbox: an outbox row is written in the same
-- transaction as the audit event it describes, so no event is lost and none is sent twice.
CREATE TABLE org_webhooks (
    id         UUID PRIMARY KEY,
    org_id     UUID          NOT NULL REFERENCES organizations (id),
    url        VARCHAR(2048) NOT NULL,
    secret     VARCHAR(100)  NOT NULL,
    events     TEXT[]        NOT NULL,
    active     BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ   NOT NULL
);
CREATE INDEX idx_org_webhooks_org ON org_webhooks (org_id) WHERE active;

CREATE TABLE outbox_events (
    id              BIGSERIAL PRIMARY KEY,
    webhook_id      UUID        NOT NULL REFERENCES org_webhooks (id) ON DELETE CASCADE,
    event_type      VARCHAR(40) NOT NULL,
    payload         JSONB       NOT NULL,
    attempts        INTEGER     NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    delivered_at    TIMESTAMPTZ,
    last_status     INTEGER,
    last_error      VARCHAR(500),
    created_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_outbox_due ON outbox_events (next_attempt_at) WHERE delivered_at IS NULL;
