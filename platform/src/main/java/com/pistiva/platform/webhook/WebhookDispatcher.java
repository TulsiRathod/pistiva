package com.pistiva.platform.webhook;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import com.pistiva.platform.observability.PlatformMetrics;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

/**
 * Delivers queued webhook events. Each request carries
 * {@code X-Pistiva-Signature: sha256=HMAC_SHA256(secret, timestamp + "." + body)} so the receiver
 * can verify it came from the platform and is fresh. Failures retry with exponential backoff
 * (10 s doubling, capped at one hour) up to {@value #MAX_ATTEMPTS} attempts.
 */
@Component
public class WebhookDispatcher {

    static final int MAX_ATTEMPTS = 10;
    private static final Logger log = LoggerFactory.getLogger(WebhookDispatcher.class);

    private final JdbcTemplate jdbc;
    private final PlatformMetrics metrics;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();

    private final boolean allowPrivate;

    public WebhookDispatcher(JdbcTemplate jdbc, PlatformMetrics metrics,
                             @org.springframework.beans.factory.annotation.Value("${pistiva.webhooks.allow-http:false}") boolean allowPrivate) {
        this.jdbc = jdbc;
        this.metrics = metrics;
        this.allowPrivate = allowPrivate;
    }

    @Scheduled(fixedDelayString = "${pistiva.webhooks.dispatch-interval:5s}", initialDelayString = "${pistiva.webhooks.dispatch-interval:5s}")
    public void scheduled() {
        try {
            dispatchDue();
        } catch (RuntimeException e) {
            log.warn("Webhook dispatch failed: {}", e.getMessage());
        }
    }

    /** Delivers up to 20 due events; rows are locked so several platform instances never send one twice. */
    @Transactional
    public int dispatchDue() {
        List<Map<String, Object>> due = jdbc.queryForList("""
                SELECT o.id, o.event_type, o.payload::text AS payload, o.attempts, w.url, w.secret
                FROM outbox_events o JOIN org_webhooks w ON w.id = o.webhook_id
                WHERE o.delivered_at IS NULL AND o.next_attempt_at <= now() AND o.attempts < ? AND w.active
                ORDER BY o.id
                LIMIT 20
                FOR UPDATE OF o SKIP LOCKED""", MAX_ATTEMPTS);
        for (Map<String, Object> row : due) {
            deliver(((Number) row.get("id")).longValue(), (String) row.get("event_type"), (String) row.get("payload"),
                    ((Number) row.get("attempts")).intValue(), (String) row.get("url"), (String) row.get("secret"));
        }
        return due.size();
    }

    private void deliver(long id, String type, String body, int attempts, String url, String secret) {
        String timestamp = String.valueOf(Instant.now().getEpochSecond());
        Integer status = null;
        String error = null;
        try {
            if (!allowPrivate) {
                String problem = UrlGuard.problem(URI.create(url));
                if (problem != null) {
                    throw new IllegalStateException(problem);
                }
            }
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(10))
                    .header("Content-Type", "application/json")
                    .header("User-Agent", "Pistiva-Webhooks/1")
                    .header("X-Pistiva-Event", type)
                    .header("X-Pistiva-Delivery", String.valueOf(id))
                    .header("X-Pistiva-Timestamp", timestamp)
                    .header("X-Pistiva-Signature", "sha256=" + sign(secret, timestamp + "." + body))
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
            status = http.send(request, HttpResponse.BodyHandlers.discarding()).statusCode();
        } catch (Exception e) {
            error = e.getClass().getSimpleName() + ": " + e.getMessage();
        }
        boolean delivered = status != null && status >= 200 && status < 300;
        metrics.webhookDelivery(delivered);
        if (delivered) {
            jdbc.update("UPDATE outbox_events SET delivered_at = now(), attempts = attempts + 1, last_status = ?, last_error = NULL WHERE id = ?", status, id);
            return;
        }
        long backoffSeconds = Math.min(10L << Math.min(attempts, 20), 3600L);
        String reason = error != null ? error : "HTTP " + status;
        jdbc.update("""
                UPDATE outbox_events SET attempts = attempts + 1, last_status = ?, last_error = ?,
                       next_attempt_at = now() + (? || ' seconds')::interval WHERE id = ?""",
                status, reason.length() > 500 ? reason.substring(0, 500) : reason, String.valueOf(backoffSeconds), id);
    }

    static String sign(String secret, String data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(data.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
