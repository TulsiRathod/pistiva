package com.pistiva.platform.agent;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

/** The latest signed agent card. Stored verbatim so any party can re-verify the signature. */
@Entity
@Table(name = "agent_cards")
public class AgentCard {

    @Id
    @Column(name = "agent_id")
    private UUID agentId;
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "card_json")
    private String cardJson;
    private String signature;
    private String kid;
    @Column(name = "published_at")
    private Instant publishedAt;

    protected AgentCard() {
    }

    public AgentCard(UUID agentId) {
        this.agentId = agentId;
    }

    public void publish(String cardJson, String signature, String kid) {
        this.cardJson = cardJson;
        this.signature = signature;
        this.kid = kid;
        this.publishedAt = Instant.now();
    }

    public UUID getAgentId() { return agentId; }
    public String getCardJson() { return cardJson; }
    public String getSignature() { return signature; }
    public String getKid() { return kid; }
    public Instant getPublishedAt() { return publishedAt; }
}
