-- The provider's per-task price from its signed card, fixed when the grant is issued.
ALTER TABLE task_grants ADD COLUMN price_amount NUMERIC(18, 2);
ALTER TABLE task_grants ADD COLUMN price_currency VARCHAR(3);

-- One row per completed, countersigned task that carried a price: what the requester owes the provider.
CREATE TABLE usage_records (
    task_id           UUID PRIMARY KEY,
    grant_id          UUID           NOT NULL,
    requester_org_id  UUID           NOT NULL REFERENCES organizations (id),
    provider_org_id   UUID           NOT NULL REFERENCES organizations (id),
    provider_agent_id UUID           NOT NULL REFERENCES agents (id),
    capability        VARCHAR(100)   NOT NULL,
    amount            NUMERIC(18, 2) NOT NULL,
    currency          VARCHAR(3)     NOT NULL,
    connection        VARCHAR(10)    NOT NULL CHECK (connection IN ('direct', 'relayed')),
    completed_at      TIMESTAMPTZ    NOT NULL
);
CREATE INDEX idx_usage_provider ON usage_records (provider_org_id, completed_at);
CREATE INDEX idx_usage_requester ON usage_records (requester_org_id, completed_at);

-- Manual payouts to providers, one per organization, month and currency.
CREATE TABLE payouts (
    id        UUID PRIMARY KEY,
    org_id    UUID           NOT NULL REFERENCES organizations (id),
    period    CHAR(7)        NOT NULL,
    currency  VARCHAR(3)     NOT NULL,
    tasks     INTEGER        NOT NULL,
    gross     NUMERIC(18, 2) NOT NULL,
    fee       NUMERIC(18, 2) NOT NULL,
    net       NUMERIC(18, 2) NOT NULL,
    reference VARCHAR(200)   NOT NULL,
    paid_by   VARCHAR(320)   NOT NULL,
    paid_at   TIMESTAMPTZ    NOT NULL,
    UNIQUE (org_id, period, currency)
);
