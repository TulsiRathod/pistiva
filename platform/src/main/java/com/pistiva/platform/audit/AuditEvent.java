package com.pistiva.platform.audit;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

/** Minimal operational metadata about a task. Never contains request or response payloads. */
@Entity
@Table(name = "audit_events")
public class AuditEvent {

    @Id
    private UUID id;
    @Column(name = "task_id")
    private UUID taskId;
    private String type;
    private String actor;
    @Column(name = "requester_org_id")
    private UUID requesterOrgId;
    @Column(name = "provider_org_id")
    private UUID providerOrgId;
    @Column(name = "request_hash")
    private String requestHash;
    @Column(name = "response_hash")
    private String responseHash;
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "details_json")
    private String detailsJson;
    @Column(name = "created_at")
    private Instant createdAt;

    protected AuditEvent() {
    }

    AuditEvent(UUID taskId, String type, String actor, UUID requesterOrgId, UUID providerOrgId,
               String requestHash, String responseHash, String detailsJson) {
        this.id = UUID.randomUUID();
        this.taskId = taskId;
        this.type = type;
        this.actor = actor;
        this.requesterOrgId = requesterOrgId;
        this.providerOrgId = providerOrgId;
        this.requestHash = requestHash;
        this.responseHash = responseHash;
        this.detailsJson = detailsJson;
        this.createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public UUID getTaskId() { return taskId; }
    public String getType() { return type; }
    public String getActor() { return actor; }
    public UUID getRequesterOrgId() { return requesterOrgId; }
    public UUID getProviderOrgId() { return providerOrgId; }
    public String getRequestHash() { return requestHash; }
    public String getResponseHash() { return responseHash; }
    public String getDetailsJson() { return detailsJson; }
    public Instant getCreatedAt() { return createdAt; }
}
