package com.pistiva.platform.agent;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/** A registered agent public key. The matching private key never leaves the agent's gateway. */
@Entity
@Table(name = "agent_keys")
public class AgentKey {

    @Id
    private String kid;
    @Column(name = "agent_id")
    private UUID agentId;
    @Column(name = "public_key")
    private String publicKey;
    @Column(name = "created_at")
    private Instant createdAt;
    @Column(name = "revoked_at")
    private Instant revokedAt;

    protected AgentKey() {
    }

    public AgentKey(String kid, UUID agentId, String publicKey) {
        this.kid = kid;
        this.agentId = agentId;
        this.publicKey = publicKey;
        this.createdAt = Instant.now();
    }

    public String getKid() { return kid; }
    public UUID getAgentId() { return agentId; }
    public String getPublicKey() { return publicKey; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getRevokedAt() { return revokedAt; }

    public boolean isRevoked() { return revokedAt != null; }

    public void revoke() {
        if (revokedAt == null) {
            revokedAt = Instant.now();
        }
    }
}
