package com.pistiva.platform.audit;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pistiva.platform.webhook.WebhookOutbox;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

@Service
public class AuditService {

    private final AuditEventRepository events;
    private final WebhookOutbox outbox;
    private final ObjectMapper mapper;

    public AuditService(AuditEventRepository events, WebhookOutbox outbox, ObjectMapper mapper) {
        this.events = events;
        this.outbox = outbox;
        this.mapper = mapper;
    }

    /**
     * Records in its own transaction so that denials are audited even though the
     * surrounding request is rolled back.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void record(UUID taskId, String type, String actor, UUID requesterOrgId, UUID providerOrgId,
                       String requestHash, String responseHash, Map<String, ?> details) {
        AuditEvent event = events.save(new AuditEvent(taskId, type, actor, requesterOrgId, providerOrgId,
                requestHash, responseHash, toJson(details)));
        // Same transaction as the audit row: the webhook is queued exactly when the event is recorded.
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("id", event.getId());
        payload.put("type", type);
        payload.put("taskId", taskId);
        payload.put("actor", actor);
        payload.put("requesterOrgId", requesterOrgId);
        payload.put("providerOrgId", providerOrgId);
        payload.put("requestHash", requestHash);
        payload.put("responseHash", responseHash);
        payload.put("details", details);
        payload.put("createdAt", event.getCreatedAt().toString());
        outbox.enqueue(type, payload, requesterOrgId, providerOrgId != null && providerOrgId.equals(requesterOrgId) ? null : providerOrgId);
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
