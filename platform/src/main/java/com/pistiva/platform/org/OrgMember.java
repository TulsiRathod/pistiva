package com.pistiva.platform.org;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.util.Set;
import java.util.UUID;

@Entity
@Table(name = "org_members")
public class OrgMember {

    public enum Role {
        OWNER, ADMIN, DEVELOPER, APPROVER;

        public static final Set<Role> MANAGE_ORG = Set.of(OWNER, ADMIN);
        public static final Set<Role> MANAGE_AGENTS = Set.of(OWNER, ADMIN, DEVELOPER);
    }

    @Id
    private UUID id;
    @Column(name = "org_id")
    private UUID orgId;
    @Column(name = "user_id")
    private UUID userId;
    @Enumerated(EnumType.STRING)
    private Role role;

    protected OrgMember() {
    }

    public OrgMember(UUID orgId, UUID userId, Role role) {
        this.id = UUID.randomUUID();
        this.orgId = orgId;
        this.userId = userId;
        this.role = role;
    }

    public UUID getId() { return id; }
    public UUID getOrgId() { return orgId; }
    public UUID getUserId() { return userId; }
    public Role getRole() { return role; }
}
