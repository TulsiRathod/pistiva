package com.pistiva.platform.webhook;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.UUID;

/**
 * Writes outbox rows. Called from inside the audit event's transaction, so an event is queued for
 * delivery if and only if it was recorded.
 */
@Component
public class WebhookOutbox {

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public WebhookOutbox(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    /** Queues the event for every active webhook of the involved organizations that subscribed to it. */
    public void enqueue(String type, Map<String, Object> payload, UUID... orgIds) {
        String json;
        try {
            json = mapper.writeValueAsString(payload);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
        for (UUID orgId : orgIds) {
            if (orgId == null) {
                continue;
            }
            jdbc.update("""
                    INSERT INTO outbox_events (webhook_id, event_type, payload, next_attempt_at, created_at)
                    SELECT id, ?, ?::jsonb, now(), now() FROM org_webhooks
                    WHERE org_id = ? AND active AND (? = ANY(events) OR '*' = ANY(events))""",
                    type, json, orgId, type);
        }
    }
}
