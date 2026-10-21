-- Organizations whose agents may run the conformance suite against partners and submit the result.
ALTER TABLE organizations ADD COLUMN certifier BOOLEAN NOT NULL DEFAULT FALSE;

-- One row per conformance run of an agent against one task-type version. The latest row decides.
CREATE TABLE certifications (
    id                 UUID PRIMARY KEY,
    agent_id           UUID         NOT NULL REFERENCES agents (id),
    org_id             UUID         NOT NULL REFERENCES organizations (id),
    task_type          VARCHAR(100) NOT NULL,
    task_type_version  INTEGER      NOT NULL,
    status             VARCHAR(20)  NOT NULL CHECK (status IN ('PASSED', 'FAILED', 'REVOKED')),
    suite_version      VARCHAR(20)  NOT NULL,
    checks_passed      INTEGER      NOT NULL,
    checks_total       INTEGER      NOT NULL,
    report_json        TEXT         NOT NULL,
    report_hash        VARCHAR(64)  NOT NULL,
    certifier_agent_id UUID         NOT NULL REFERENCES agents (id),
    created_at         TIMESTAMPTZ  NOT NULL,
    expires_at         TIMESTAMPTZ  NOT NULL,
    revoked_at         TIMESTAMPTZ,
    revoked_reason     VARCHAR(500)
);
CREATE INDEX idx_certifications_agent ON certifications (agent_id, task_type, task_type_version, created_at DESC);
