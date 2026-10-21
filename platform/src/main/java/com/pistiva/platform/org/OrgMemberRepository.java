package com.pistiva.platform.org;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OrgMemberRepository extends JpaRepository<OrgMember, UUID> {
    Optional<OrgMember> findByOrgIdAndUserId(UUID orgId, UUID userId);

    List<OrgMember> findByUserId(UUID userId);

    List<OrgMember> findByOrgId(UUID orgId);
}
