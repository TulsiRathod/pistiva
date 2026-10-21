package com.pistiva.platform.policy;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * Per-agent token bucket kept in Postgres, so it holds across platform instances without Redis.
 * Runs in its own transaction: a token spent on a request that is later denied stays spent.
 */
@Component
public class RateLimiter {

    private final JdbcTemplate jdbc;

    public RateLimiter(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public boolean tryAcquire(UUID agentId, int perMinute) {
        Instant now = Instant.now();
        jdbc.update("INSERT INTO rate_buckets (agent_id, tokens, updated_at) VALUES (?, ?, ?) ON CONFLICT (agent_id) DO NOTHING",
                agentId, (double) perMinute, Timestamp.from(now));
        Map<String, Object> row = jdbc.queryForMap(
                "SELECT tokens, updated_at FROM rate_buckets WHERE agent_id = ? FOR UPDATE", agentId);
        double tokens = ((Number) row.get("tokens")).doubleValue();
        Instant updatedAt = ((Timestamp) row.get("updated_at")).toInstant();
        double elapsedSeconds = Math.max(0, (now.toEpochMilli() - updatedAt.toEpochMilli()) / 1000.0);
        tokens = Math.min(perMinute, tokens + elapsedSeconds * perMinute / 60.0);
        boolean allowed = tokens >= 1.0;
        if (allowed) {
            tokens -= 1.0;
        }
        jdbc.update("UPDATE rate_buckets SET tokens = ?, updated_at = ? WHERE agent_id = ?",
                tokens, Timestamp.from(now), agentId);
        return allowed;
    }
}
