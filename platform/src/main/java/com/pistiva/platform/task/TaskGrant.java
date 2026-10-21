package com.pistiva.platform.task;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "task_grants")
public class TaskGrant {

    public enum Status { ISSUED, COMPLETED }

    @Id
    private UUID jti;
    @Column(name = "task_id")
    private UUID taskId;
    @Column(name = "requester_agent_id")
    private UUID requesterAgentId;
    @Column(name = "provider_agent_id")
    private UUID providerAgentId;
    private String capability;
    @Column(name = "task_type_version")
    private int taskTypeVersion;
    private BigDecimal budget;
    private String currency;
    @Column(name = "approval_required")
    private boolean approvalRequired;
    @Column(name = "expires_at")
    private Instant expiresAt;
    @Enumerated(EnumType.STRING)
    private Status status;
    @Column(name = "created_at")
    private Instant createdAt;
    @Column(name = "continues_grant")
    private UUID continuesGrant;

    protected TaskGrant() {
    }

    public TaskGrant(UUID taskId, UUID requesterAgentId, UUID providerAgentId, String capability, int taskTypeVersion,
                     BigDecimal budget, String currency, boolean approvalRequired, Instant expiresAt, UUID continuesGrant) {
        this.jti = UUID.randomUUID();
        this.taskId = taskId;
        this.requesterAgentId = requesterAgentId;
        this.providerAgentId = providerAgentId;
        this.capability = capability;
        this.taskTypeVersion = taskTypeVersion;
        this.budget = budget;
        this.currency = currency;
        this.approvalRequired = approvalRequired;
        this.expiresAt = expiresAt;
        this.status = Status.ISSUED;
        this.createdAt = Instant.now();
        this.continuesGrant = continuesGrant;
    }

    public UUID getJti() { return jti; }
    public UUID getTaskId() { return taskId; }
    public UUID getRequesterAgentId() { return requesterAgentId; }
    public UUID getProviderAgentId() { return providerAgentId; }
    public String getCapability() { return capability; }
    public int getTaskTypeVersion() { return taskTypeVersion; }
    public UUID getContinuesGrant() { return continuesGrant; }
    public BigDecimal getBudget() { return budget; }
    public String getCurrency() { return currency; }
    public boolean isApprovalRequired() { return approvalRequired; }
    public Instant getExpiresAt() { return expiresAt; }
    public Status getStatus() { return status; }
    public Instant getCreatedAt() { return createdAt; }

    public void complete() { this.status = Status.COMPLETED; }
}
