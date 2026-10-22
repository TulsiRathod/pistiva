package com.pistiva.platform.webhook;

import com.pistiva.platform.common.ApiException;
import com.pistiva.platform.common.Ed25519;
import com.pistiva.platform.org.OrgMember.Role;
import com.pistiva.platform.org.OrgService;
import com.pistiva.platform.security.Principals.UserPrincipal;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.security.SecureRandom;
import java.sql.Array;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** Webhook subscriptions per organization. The signing secret is shown once, at creation. */
@Service
public class WebhookService {

    private static final SecureRandom RANDOM = new SecureRandom();
    /** Audit event types an organization can subscribe to; "*" means all of them. */
    public static final Set<String> EVENT_TYPES = Set.of("*", "GRANT_ISSUED", "GRANT_DENIED", "RECEIPT_RECORDED",
            "APPROVAL_REQUESTED", "APPROVAL_DECIDED", "TASK_EXPIRED", "AGENT_STATUS_CHANGED", "AGENT_KEY_REVOKED", "ORG_VERIFIED",
            "AGENT_CERTIFIED", "CERTIFICATION_FAILED", "CERTIFICATION_REVOKED");

    private final JdbcTemplate jdbc;
    private final OrgService orgService;
    private final boolean allowHttp;

    public WebhookService(JdbcTemplate jdbc, OrgService orgService, @Value("${pistiva.webhooks.allow-http:false}") boolean allowHttp) {
        this.jdbc = jdbc;
        this.orgService = orgService;
        this.allowHttp = allowHttp;
    }

    public record Webhook(UUID id, UUID orgId, String url, List<String> events, boolean active, Instant createdAt, String secret) {
    }

    public record Delivery(long id, String eventType, int attempts, Integer lastStatus, String lastError, Instant deliveredAt,
                           Instant nextAttemptAt, Instant createdAt) {
    }

    public Webhook create(UserPrincipal user, UUID orgId, String url, List<String> events) {
        orgService.requireRole(user, orgId, Role.MANAGE_ORG);
        validateUrl(url);
        if (events == null || events.isEmpty() || !EVENT_TYPES.containsAll(events)) {
            throw new ApiException.BadRequest("events must be a non-empty subset of " + EVENT_TYPES);
        }
        byte[] raw = new byte[32];
        RANDOM.nextBytes(raw);
        String secret = "whsec_" + Ed25519.b64url(raw);
        UUID id = UUID.randomUUID();
        Instant now = Instant.now();
        jdbc.update("INSERT INTO org_webhooks (id, org_id, url, secret, events, active, created_at) VALUES (?, ?, ?, ?, ?, TRUE, ?)",
                ps -> {
                    ps.setObject(1, id);
                    ps.setObject(2, orgId);
                    ps.setString(3, url);
                    ps.setString(4, secret);
                    ps.setArray(5, ps.getConnection().createArrayOf("text", events.toArray()));
                    ps.setTimestamp(6, Timestamp.from(now));
                });
        return new Webhook(id, orgId, url, events, true, now, secret);
    }

    public List<Webhook> list(UserPrincipal user, UUID orgId) {
        orgService.requireMember(user, orgId);
        return jdbc.query("SELECT id, org_id, url, events, active, created_at FROM org_webhooks WHERE org_id = ? ORDER BY created_at",
                (rs, i) -> new Webhook(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3), toList(rs.getArray(4)),
                        rs.getBoolean(5), rs.getTimestamp(6).toInstant(), null),
                orgId);
    }

    public void delete(UserPrincipal user, UUID orgId, UUID webhookId) {
        orgService.requireRole(user, orgId, Role.MANAGE_ORG);
        if (jdbc.update("DELETE FROM org_webhooks WHERE id = ? AND org_id = ?", webhookId, orgId) == 0) {
            throw new ApiException.NotFound("Webhook not found");
        }
    }

    public List<Delivery> deliveries(UserPrincipal user, UUID orgId, UUID webhookId) {
        orgService.requireMember(user, orgId);
        return jdbc.query("""
                SELECT o.id, o.event_type, o.attempts, o.last_status, o.last_error, o.delivered_at, o.next_attempt_at, o.created_at
                FROM outbox_events o JOIN org_webhooks w ON w.id = o.webhook_id
                WHERE w.id = ? AND w.org_id = ? ORDER BY o.id DESC LIMIT 100""",
                (rs, i) -> new Delivery(rs.getLong(1), rs.getString(2), rs.getInt(3), (Integer) rs.getObject(4), rs.getString(5),
                        ts(rs.getTimestamp(6)), ts(rs.getTimestamp(7)), ts(rs.getTimestamp(8))),
                webhookId, orgId);
    }

    private void validateUrl(String url) {
        URI uri;
        try {
            uri = URI.create(url);
        } catch (IllegalArgumentException e) {
            throw new ApiException.BadRequest("Invalid webhook URL");
        }
        boolean https = "https".equals(uri.getScheme());
        if (uri.getHost() == null || !(https || (allowHttp && "http".equals(uri.getScheme())))) {
            throw new ApiException.BadRequest("Webhook URL must be https");
        }
        // allow-http is a development switch; it also lets webhooks reach local test servers.
        String problem = allowHttp ? null : UrlGuard.problem(uri);
        if (problem != null) {
            throw new ApiException.BadRequest(problem);
        }
    }

    private static List<String> toList(Array a) throws java.sql.SQLException {
        return a == null ? List.of() : Arrays.asList((String[]) a.getArray());
    }

    private static Instant ts(Timestamp t) {
        return t == null ? null : t.toInstant();
    }
}
