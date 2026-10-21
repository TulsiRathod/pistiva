-- Task-type contract registry. Agent cards may only advertise registered task types, and every
-- grant pins one task-type version, so both parties agree on message shapes before talking.

CREATE TABLE task_types (
    name        VARCHAR(100) PRIMARY KEY,
    pack        VARCHAR(100) NOT NULL,
    description VARCHAR(1000) NOT NULL,
    extension   BOOLEAN      NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL
);

CREATE TABLE task_type_versions (
    name        VARCHAR(100) NOT NULL REFERENCES task_types (name),
    version     INTEGER      NOT NULL,
    direction   VARCHAR(30)  NOT NULL,
    cardinality VARCHAR(20)  NOT NULL,
    handler     VARCHAR(100) NOT NULL,
    -- {"request": schema, "clarification": schema, "answer": schema, "result": schema}
    messages    JSONB        NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL,
    PRIMARY KEY (name, version)
);

-- Capabilities now name a specific contract version.
ALTER TABLE agent_capabilities ADD COLUMN task_type_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE task_grants ADD COLUMN task_type_version INTEGER NOT NULL DEFAULT 1;
-- A task may span several grants when clarification rounds outlive one grant.
ALTER TABLE task_grants ADD COLUMN continues_grant UUID REFERENCES task_grants (jti);

-- One receipt per message round; the task completes with a receipt in a terminal state.
CREATE TABLE task_receipts (
    task_id             UUID         NOT NULL,
    round               INTEGER      NOT NULL,
    grant_id            UUID         NOT NULL REFERENCES task_grants (jti),
    state               VARCHAR(30)  NOT NULL,
    request_hash        VARCHAR(100) NOT NULL,
    response_hash       VARCHAR(100) NOT NULL,
    provider_kid        VARCHAR(64)  NOT NULL,
    provider_signature  VARCHAR(128) NOT NULL,
    requester_kid       VARCHAR(64)  NOT NULL,
    requester_signature VARCHAR(128) NOT NULL,
    recorded_at         TIMESTAMPTZ  NOT NULL,
    PRIMARY KEY (task_id, round)
);
