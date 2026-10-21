-- Control-plane schema. Holds identity, registry, policy and audit metadata only:
-- task request/response payloads never reach the platform.

CREATE TABLE organizations (
    id                  UUID PRIMARY KEY,
    name                VARCHAR(200) NOT NULL,
    domain              VARCHAR(253) NOT NULL UNIQUE,
    verification_status VARCHAR(20)  NOT NULL,
    verification_token  VARCHAR(64)  NOT NULL,
    status              VARCHAR(20)  NOT NULL,
    created_at          TIMESTAMPTZ  NOT NULL
);

CREATE TABLE users (
    id             UUID PRIMARY KEY,
    email          VARCHAR(320) NOT NULL UNIQUE,
    password_hash  VARCHAR(100) NOT NULL,
    platform_admin BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ  NOT NULL
);

CREATE TABLE org_members (
    id      UUID PRIMARY KEY,
    org_id  UUID        NOT NULL REFERENCES organizations (id),
    user_id UUID        NOT NULL REFERENCES users (id),
    role    VARCHAR(20) NOT NULL,
    UNIQUE (org_id, user_id)
);

CREATE TABLE agents (
    id           UUID PRIMARY KEY,
    org_id       UUID         NOT NULL REFERENCES organizations (id),
    name         VARCHAR(200) NOT NULL,
    version      VARCHAR(50)  NOT NULL,
    endpoint_url VARCHAR(2048) NOT NULL,
    status       VARCHAR(20)  NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL
);
CREATE INDEX idx_agents_org ON agents (org_id);

-- Public keys only. Private keys stay in the customer's gateway.
CREATE TABLE agent_keys (
    kid        VARCHAR(64) PRIMARY KEY,
    agent_id   UUID        NOT NULL REFERENCES agents (id),
    public_key VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX idx_agent_keys_agent ON agent_keys (agent_id);

CREATE TABLE agent_cards (
    agent_id     UUID PRIMARY KEY REFERENCES agents (id),
    card_json    JSONB        NOT NULL,
    signature    VARCHAR(128) NOT NULL,
    kid          VARCHAR(64)  NOT NULL REFERENCES agent_keys (kid),
    published_at TIMESTAMPTZ  NOT NULL
);

CREATE TABLE agent_capabilities (
    id          UUID PRIMARY KEY,
    agent_id    UUID         NOT NULL REFERENCES agents (id),
    capability  VARCHAR(100) NOT NULL,
    price_model JSONB,
    UNIQUE (agent_id, capability)
);
CREATE INDEX idx_agent_capabilities_capability ON agent_capabilities (capability);

CREATE TABLE policies (
    org_id     UUID PRIMARY KEY REFERENCES organizations (id),
    rules_json JSONB       NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE task_grants (
    jti                UUID PRIMARY KEY,
    task_id            UUID           NOT NULL,
    requester_agent_id UUID           NOT NULL REFERENCES agents (id),
    provider_agent_id  UUID           NOT NULL REFERENCES agents (id),
    capability         VARCHAR(100)   NOT NULL,
    budget             NUMERIC(18, 2) NOT NULL,
    currency           VARCHAR(3)     NOT NULL,
    approval_required  BOOLEAN        NOT NULL,
    expires_at         TIMESTAMPTZ    NOT NULL,
    status             VARCHAR(20)    NOT NULL,
    created_at         TIMESTAMPTZ    NOT NULL
);
CREATE INDEX idx_task_grants_task ON task_grants (task_id);

CREATE TABLE rate_buckets (
    agent_id   UUID PRIMARY KEY REFERENCES agents (id),
    tokens     DOUBLE PRECISION NOT NULL,
    updated_at TIMESTAMPTZ      NOT NULL
);

CREATE TABLE audit_events (
    id                 UUID PRIMARY KEY,
    task_id            UUID,
    type               VARCHAR(40)  NOT NULL,
    actor              VARCHAR(100) NOT NULL,
    requester_org_id   UUID,
    provider_org_id    UUID,
    request_hash       VARCHAR(100),
    response_hash      VARCHAR(100),
    details_json       JSONB,
    created_at         TIMESTAMPTZ  NOT NULL
);
CREATE INDEX idx_audit_events_task ON audit_events (task_id);
CREATE INDEX idx_audit_events_requester_org ON audit_events (requester_org_id);
CREATE INDEX idx_audit_events_provider_org ON audit_events (provider_org_id);
