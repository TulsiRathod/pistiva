package com.pistiva.platform.audit;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.Map;
import java.util.UUID;

@Service
public class AuditService {

    private final AuditEventRepository events;
    private final ObjectMapper mapper;

    public AuditService(AuditEventRepository events, ObjectMapper mapper) {
        this.events = events;
        this.mapper = mapper;
    }

    /**
     * Records in its own transaction so that denials are audited even though the
     * surrounding request is rolled back.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void record(UUID taskId, String type, String actor, UUID requesterOrgId, UUID providerOrgId,
                       String requestHash, String responseHash, Map<String, ?> details) {
        events.save(new AuditEvent(taskId, type, actor, requesterOrgId, providerOrgId,
                requestHash, responseHash, toJson(details)));
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void record(String type, String actor, UUID orgId, Map<String, ?> details) {
        record(null, type, actor, orgId, null, null, null, details);
    }

    private String toJson(Map<String, ?> details) {
        if (details == null || details.isEmpty()) {
            return null;
        }
        try {
            return mapper.writeValueAsString(details);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
