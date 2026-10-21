package com.pistiva.platform.admin;

import com.pistiva.platform.common.ApiException;
import com.pistiva.platform.security.Principals;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Network-wide views for platform admins: counts, daily activity and recent events.
 * Everything here is control-plane metadata; task payloads are never stored, so none can appear.
 */
@RestController
@RequestMapping("/admin")
public class AdminController {

    private final JdbcTemplate jdbc;

    public AdminController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record Counts(long total, long verified, long pending, long suspended) {
    }

    public record AgentCounts(long total, long active, long suspended, long liveKeys, long revokedKeys) {
    }

    public record DayActivity(String date, long grantsIssued, long grantsDenied, long receipts) {
    }

    public record Overview(Counts organizations, AgentCounts agents, long taskTypes, long grantsIssued,
                           long grantsDenied, long receipts, List<DayActivity> activity) {
    }

    public record RecentEvent(UUID id, String type, String actor, UUID taskId, String requesterOrg, String providerOrg,
                              String details, Instant createdAt) {
    }

    public record OrgRow(UUID id, String name, String domain, String verificationStatus, String status, Instant createdAt,
                         long members, long agents, long activeAgents, Instant lastActivity, boolean certifier) {
    }

    @GetMapping("/overview")
    public Overview overview(@RequestParam(defaultValue = "14") int days) {
        requireAdmin();
        int window = Math.max(1, Math.min(days, 90));
        Counts orgs = jdbc.queryForObject("""
                SELECT count(*),
                       count(*) FILTER (WHERE verification_status = 'VERIFIED'),
                       count(*) FILTER (WHERE verification_status = 'PENDING'),
                       count(*) FILTER (WHERE status = 'SUSPENDED')
                FROM organizations""",
                (rs, i) -> new Counts(rs.getLong(1), rs.getLong(2), rs.getLong(3), rs.getLong(4)));
        AgentCounts agents = jdbc.queryForObject("""
                SELECT (SELECT count(*) FROM agents),
                       (SELECT count(*) FROM agents WHERE status = 'ACTIVE'),
                       (SELECT count(*) FROM agents WHERE status = 'SUSPENDED'),
                       (SELECT count(*) FROM agent_keys WHERE revoked_at IS NULL),
                       (SELECT count(*) FROM agent_keys WHERE revoked_at IS NOT NULL)""",
                (rs, i) -> new AgentCounts(rs.getLong(1), rs.getLong(2), rs.getLong(3), rs.getLong(4), rs.getLong(5)));
        long taskTypes = jdbc.queryForObject("SELECT count(*) FROM task_type_versions", Long.class);
        Map<String, Long> totals = jdbc.query("""
                SELECT type, count(*) FROM audit_events
                WHERE type IN ('GRANT_ISSUED', 'GRANT_DENIED', 'RECEIPT_RECORDED') GROUP BY type""",
                rs -> {
                    Map<String, Long> m = new LinkedHashMap<>();
                    while (rs.next()) {
                        m.put(rs.getString(1), rs.getLong(2));
                    }
                    return m;
                });

        // One row per UTC day, including days with no events, so the chart has a continuous axis.
        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        LocalDate from = today.minusDays(window - 1L);
        Map<LocalDate, long[]> byDay = new LinkedHashMap<>();
        for (LocalDate d = from; !d.isAfter(today); d = d.plusDays(1)) {
            byDay.put(d, new long[3]);
        }
        jdbc.query("""
                SELECT (created_at AT TIME ZONE 'UTC')::date AS day, type, count(*)
                FROM audit_events
                WHERE created_at >= ? AND type IN ('GRANT_ISSUED', 'GRANT_DENIED', 'RECEIPT_RECORDED')
                GROUP BY day, type""",
                rs -> {
                    long[] row = byDay.get(rs.getDate(1).toLocalDate());
                    if (row != null) {
                        int slot = switch (rs.getString(2)) {
                            case "GRANT_ISSUED" -> 0;
                            case "GRANT_DENIED" -> 1;
                            default -> 2;
                        };
                        row[slot] = rs.getLong(3);
                    }
                },
                Timestamp.from(from.atStartOfDay(ZoneOffset.UTC).toInstant()));
        List<DayActivity> activity = byDay.entrySet().stream()
                .map(e -> new DayActivity(e.getKey().toString(), e.getValue()[0], e.getValue()[1], e.getValue()[2]))
                .toList();

        return new Overview(orgs, agents, taskTypes, totals.getOrDefault("GRANT_ISSUED", 0L),
                totals.getOrDefault("GRANT_DENIED", 0L), totals.getOrDefault("RECEIPT_RECORDED", 0L), activity);
    }

    @GetMapping("/events")
    public List<RecentEvent> events(@RequestParam(defaultValue = "25") int limit) {
        requireAdmin();
        return jdbc.query("""
                SELECT e.id, e.type, e.actor, e.task_id, ro.name, po.name, e.details_json, e.created_at
                FROM audit_events e
                LEFT JOIN organizations ro ON ro.id = e.requester_org_id
                LEFT JOIN organizations po ON po.id = e.provider_org_id
                ORDER BY e.created_at DESC
                LIMIT ?""",
                (rs, i) -> new RecentEvent(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3),
                        rs.getObject(4, UUID.class), rs.getString(5), rs.getString(6), rs.getString(7),
                        rs.getTimestamp(8).toInstant()),
                Math.max(1, Math.min(limit, 200)));
    }

    @GetMapping("/organizations")
    public List<OrgRow> organizations() {
        requireAdmin();
        return jdbc.query("""
                SELECT o.id, o.name, o.domain, o.verification_status, o.status, o.created_at,
                       (SELECT count(*) FROM org_members m WHERE m.org_id = o.id),
                       (SELECT count(*) FROM agents a WHERE a.org_id = o.id),
                       (SELECT count(*) FROM agents a WHERE a.org_id = o.id AND a.status = 'ACTIVE'),
                       (SELECT max(created_at) FROM audit_events e WHERE e.requester_org_id = o.id OR e.provider_org_id = o.id),
                       o.certifier
                FROM organizations o
                ORDER BY o.created_at DESC""",
                (rs, i) -> {
                    Timestamp last = rs.getTimestamp(10);
                    return new OrgRow(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3), rs.getString(4),
                            rs.getString(5), rs.getTimestamp(6).toInstant(), rs.getLong(7), rs.getLong(8), rs.getLong(9),
                            last == null ? null : last.toInstant(), rs.getBoolean(11));
                });
    }

    private static void requireAdmin() {
        if (!Principals.user().platformAdmin()) {
            throw new ApiException.Forbidden("The admin dashboard requires a platform admin");
        }
    }
}
