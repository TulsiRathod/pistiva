-- WebRTC signaling between two agents. The platform relays signed SDP offers and answers; the
-- connection itself is end-to-end DTLS, so the platform (and any TURN relay) only sees ciphertext.
CREATE TABLE p2p_sessions (
    id                 UUID PRIMARY KEY,
    requester_agent_id UUID        NOT NULL REFERENCES agents (id),
    provider_agent_id  UUID        NOT NULL REFERENCES agents (id),
    offer              TEXT        NOT NULL,
    offer_signature    VARCHAR(200) NOT NULL,
    answer             TEXT,
    answer_signature   VARCHAR(200),
    created_at         TIMESTAMPTZ NOT NULL,
    expires_at         TIMESTAMPTZ NOT NULL,
    answered_at        TIMESTAMPTZ
);
CREATE INDEX idx_p2p_pending ON p2p_sessions (provider_agent_id, expires_at) WHERE answer IS NULL;
