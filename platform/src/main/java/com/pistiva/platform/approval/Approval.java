package com.pistiva.platform.approval;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "approvals")
public class Approval {

    public enum Status { PENDING, APPROVED, REJECTED, CHANGES_REQUESTED }

    @Id
    private UUID id;
    @Column(name = "org_id")
    private UUID orgId;
    @Column(name = "requester_agent_id")
    private UUID requesterAgentId;
    @Column(name = "provider_agent_id")
    private UUID providerAgentId;
    private String capability;
    private String reference;
    private BigDecimal amount;
    private String currency;
    @JdbcTypeCode(SqlTypes.JSON)
    private String summary;
    @Enumerated(EnumType.STRING)
    private Status status;
    @Column(name = "requested_at")
    private Instant requestedAt;
    @Column(name = "decided_by")
    private UUID decidedBy;
    @Column(name = "decided_at")
    private Instant decidedAt;
    private String comment;
    @Column(name = "consumed_by_grant")
    private UUID consumedByGrant;

    protected Approval() {
    }

    public Approval(UUID orgId, UUID requesterAgentId, UUID providerAgentId, String capability, String reference,
                    BigDecimal amount, String currency, String summary) {
        this.id = UUID.randomUUID();
        this.orgId = orgId;
        this.requesterAgentId = requesterAgentId;
        this.providerAgentId = providerAgentId;
        this.capability = capability;
        this.reference = reference;
        this.amount = amount;
        this.currency = currency;
        this.summary = summary;
        this.status = Status.PENDING;
        this.requestedAt = Instant.now();
    }

    public void decide(Status decision, UUID userId, String comment) {
        this.status = decision;
        this.decidedBy = userId;
        this.decidedAt = Instant.now();
        this.comment = comment;
    }

    public UUID getId() { return id; }
    public UUID getOrgId() { return orgId; }
    public UUID getRequesterAgentId() { return requesterAgentId; }
    public UUID getProviderAgentId() { return providerAgentId; }
    public String getCapability() { return capability; }
    public String getReference() { return reference; }
    public BigDecimal getAmount() { return amount; }
    public String getCurrency() { return currency; }
    public String getSummary() { return summary; }
    public Status getStatus() { return status; }
    public Instant getRequestedAt() { return requestedAt; }
    public UUID getDecidedBy() { return decidedBy; }
    public Instant getDecidedAt() { return decidedAt; }
    public String getComment() { return comment; }
    public UUID getConsumedByGrant() { return consumedByGrant; }
}
