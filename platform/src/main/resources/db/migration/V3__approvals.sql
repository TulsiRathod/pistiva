-- Human approvals for commitments (e.g. order.confirm above the approval threshold).
-- An approval belongs to the requesting organization, is decided by one of its members, and can
-- back exactly one grant.
CREATE TABLE approvals (
    id                 UUID PRIMARY KEY,
    org_id             UUID           NOT NULL REFERENCES organizations (id),
    requester_agent_id UUID           NOT NULL REFERENCES agents (id),
    provider_agent_id  UUID           NOT NULL REFERENCES agents (id),
    capability         VARCHAR(100)   NOT NULL,
    reference          VARCHAR(100)   NOT NULL,
    amount             NUMERIC(18, 2) NOT NULL,
    currency           VARCHAR(3)     NOT NULL,
    summary            JSONB,
    status             VARCHAR(20)    NOT NULL,
    requested_at       TIMESTAMPTZ    NOT NULL,
    decided_by         UUID REFERENCES users (id),
    decided_at         TIMESTAMPTZ,
    comment            VARCHAR(1000),
    -- Set when a grant is issued against it; an approval backs exactly one grant.
    consumed_by_grant  UUID
);
CREATE INDEX idx_approvals_org_status ON approvals (org_id, status, requested_at DESC);

ALTER TABLE task_grants ADD COLUMN approval_id UUID REFERENCES approvals (id);
