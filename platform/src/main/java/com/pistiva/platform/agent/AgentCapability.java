package com.pistiva.platform.agent;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.util.UUID;

/** Search index derived from the signed card; the card remains the source of truth. */
@Entity
@Table(name = "agent_capabilities")
public class AgentCapability {

    @Id
    private UUID id;
    @Column(name = "agent_id")
    private UUID agentId;
    private String capability;
    @Column(name = "task_type_version")
    private int taskTypeVersion;
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "price_model")
    private String priceModel;

    protected AgentCapability() {
    }

    public AgentCapability(UUID agentId, String capability, int taskTypeVersion, String priceModel) {
        this.id = UUID.randomUUID();
        this.agentId = agentId;
        this.capability = capability;
        this.taskTypeVersion = taskTypeVersion;
        this.priceModel = priceModel;
    }

    public UUID getId() { return id; }
    public UUID getAgentId() { return agentId; }
    public String getCapability() { return capability; }
    public int getTaskTypeVersion() { return taskTypeVersion; }
    public String getPriceModel() { return priceModel; }
}
