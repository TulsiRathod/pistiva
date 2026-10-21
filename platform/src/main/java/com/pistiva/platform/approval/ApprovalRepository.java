package com.pistiva.platform.approval;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

public interface ApprovalRepository extends JpaRepository<Approval, UUID> {

    List<Approval> findByOrgIdOrderByRequestedAtDesc(UUID orgId);

    List<Approval> findByOrgIdAndStatusOrderByRequestedAtDesc(UUID orgId, Approval.Status status);

    /** Atomically marks an approved approval as used; returns 0 if it was already used or isn't approved. */
    @Modifying
    @Transactional
    @Query("update Approval a set a.consumedByGrant = :grantId where a.id = :id and a.consumedByGrant is null and a.status = com.pistiva.platform.approval.Approval.Status.APPROVED")
    int consume(UUID id, UUID grantId);
}
