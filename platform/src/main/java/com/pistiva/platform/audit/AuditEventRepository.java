package com.pistiva.platform.audit;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.util.List;
import java.util.UUID;

public interface AuditEventRepository extends JpaRepository<AuditEvent, UUID> {

    @Query("""
            select e from AuditEvent e
            where e.requesterOrgId = :orgId or e.providerOrgId = :orgId
            order by e.createdAt desc
            """)
    List<AuditEvent> findForOrg(UUID orgId, Pageable page);

    @Query("""
            select e from AuditEvent e
            where (e.requesterOrgId = :orgId or e.providerOrgId = :orgId) and e.taskId = :taskId
            order by e.createdAt asc
            """)
    List<AuditEvent> findForOrgAndTask(UUID orgId, UUID taskId);
}
