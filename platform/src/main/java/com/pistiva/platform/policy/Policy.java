package com.pistiva.platform.policy;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "policies")
public class Policy {

    @Id
    @Column(name = "org_id")
    private UUID orgId;
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "rules_json")
    private String rulesJson;
    @Column(name = "updated_at")
    private Instant updatedAt;

    protected Policy() {
    }

    public Policy(UUID orgId, String rulesJson) {
        this.orgId = orgId;
        update(rulesJson);
    }

    public void update(String rulesJson) {
        this.rulesJson = rulesJson;
        this.updatedAt = Instant.now();
    }

    public UUID getOrgId() { return orgId; }
    public String getRulesJson() { return rulesJson; }
    public Instant getUpdatedAt() { return updatedAt; }
}
