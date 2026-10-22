package com.pistiva.platform.agent;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "agents")
public class Agent {

    public enum Status { ACTIVE, SUSPENDED }

    @Id
    private UUID id;
    @Column(name = "org_id")
    private UUID orgId;
    private String name;
    private String version;
    @Column(name = "endpoint_url")
    private String endpointUrl;
    @Enumerated(EnumType.STRING)
    private Status status;
    @Column(name = "created_at")
    private Instant createdAt;
    @Column(name = "created_by")
    private UUID createdBy;

    protected Agent() {
    }

    public Agent(UUID orgId, String name, String version, String endpointUrl) {
        this.id = UUID.randomUUID();
        this.orgId = orgId;
        this.name = name;
        this.version = version;
        this.endpointUrl = endpointUrl;
        this.status = Status.ACTIVE;
        this.createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public UUID getOrgId() { return orgId; }
    public String getName() { return name; }
    public String getVersion() { return version; }
    public String getEndpointUrl() { return endpointUrl; }
    public Status getStatus() { return status; }
    public Instant getCreatedAt() { return createdAt; }
    public UUID getCreatedBy() { return createdBy; }

    public Agent createdBy(UUID userId) {
        this.createdBy = userId;
        return this;
    }

    public boolean isActive() { return status == Status.ACTIVE; }

    public void setStatus(Status status) { this.status = status; }

    public void updateFromCard(String name, String version, String endpointUrl) {
        this.name = name;
        this.version = version;
        this.endpointUrl = endpointUrl;
    }
}
