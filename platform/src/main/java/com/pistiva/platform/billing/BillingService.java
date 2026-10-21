package com.pistiva.platform.billing;

import com.fasterxml.jackson.databind.JsonNode;
import com.pistiva.platform.audit.AuditService;
import com.pistiva.platform.common.ApiException;
import com.pistiva.platform.org.OrgService;
import com.pistiva.platform.security.Principals.UserPrincipal;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Usage metering and manual payouts. A provider's per-task price is fixed from its signed card when
 * the grant is issued; a usage record is written once, when both parties countersign the task's
 * completed receipt. Failed, rejected and canceled tasks are never charged. Amounts are per currency;
 * nothing is converted.
 */
@Service
public class BillingService {

    private final JdbcTemplate jdbc;
    private final OrgService orgService;
    private final AuditService audit;
    private final BigDecimal feePercent;

    public BillingService(JdbcTemplate jdbc, OrgService orgService, AuditService audit,
                          @Value("${pistiva.billing.platform-fee-percent:10}") BigDecimal feePercent) {
        this.jdbc = jdbc;
        this.orgService = orgService;
        this.audit = audit;
        this.feePercent = feePercent;
    }

    public record Price(BigDecimal amount, String currency) {
    }

    public record UsageRecord(UUID taskId, String role, UUID counterpartyOrgId, String counterpartyName, String capability,
                              BigDecimal amount, String currency, String connection, Instant completedAt) {
    }

    public record Total(String role, String currency, long tasks, BigDecimal amount) {
    }

    public record OrgUsage(String period, List<Total> totals, List<UsageRecord> records) {
    }

    public record PayoutLine(UUID orgId, String orgName, String currency, long tasks, BigDecimal gross, BigDecimal fee,
                             BigDecimal net, long relayedTasks, Paid paid) {
    }

    public record Paid(UUID id, BigDecimal net, String reference, String paidBy, Instant paidAt) {
    }

    /** A card's per-task price, or null when the capability is free or priced some other way. */
    public static Price perTaskPrice(JsonNode capability) {
        JsonNode price = capability.path("price");
        if (!"per_task".equals(price.path("model").asText()) || !price.hasNonNull("amount")) {
            return null;
        }
        try {
            BigDecimal amount = new BigDecimal(price.path("amount").asText()).setScale(2, RoundingMode.HALF_UP);
            String currency = price.path("currency").asText("");
            return amount.signum() > 0 && currency.matches("[A-Z]{3}") ? new Price(amount, currency) : null;
        } catch (NumberFormatException | ArithmeticException e) {
            return null;
        }
    }

    /** Called when a task's terminal "completed" receipt is recorded. Idempotent per task. */
    public void meterCompletedTask(UUID taskId, String connection) {
        jdbc.update("""
                INSERT INTO usage_records (task_id, grant_id, requester_org_id, provider_org_id, provider_agent_id, capability,
                                           amount, currency, connection, completed_at)
                SELECT g.task_id, g.jti, ra.org_id, pa.org_id, pa.id, g.capability, g.price_amount, g.price_currency, ?, now()
                FROM task_grants g
                JOIN agents ra ON ra.id = g.requester_agent_id
                JOIN agents pa ON pa.id = g.provider_agent_id
                WHERE g.task_id = ? AND g.price_amount IS NOT NULL
                ORDER BY g.created_at
                LIMIT 1
                ON CONFLICT (task_id) DO NOTHING""",
                "relayed".equals(connection) ? "relayed" : "direct", taskId);
    }

    /** What an organization earned as a provider and owes as a requester in one month. */
    public OrgUsage usage(UserPrincipal user, UUID orgId, String period) {
        orgService.requireMember(user, orgId);
        Instant[] range = range(period);
        List<Total> totals = jdbc.query("""
                SELECT CASE WHEN provider_org_id = ? THEN 'provider' ELSE 'requester' END AS role, currency, count(*), sum(amount)
                FROM usage_records
                WHERE (provider_org_id = ? OR requester_org_id = ?) AND completed_at >= ? AND completed_at < ?
                GROUP BY 1, 2 ORDER BY 1, 2""",
                (rs, i) -> new Total(rs.getString(1), rs.getString(2), rs.getLong(3), rs.getBigDecimal(4)),
                orgId, orgId, orgId, Timestamp.from(range[0]), Timestamp.from(range[1]));
        List<UsageRecord> records = jdbc.query("""
                SELECT u.task_id, CASE WHEN u.provider_org_id = ? THEN 'provider' ELSE 'requester' END,
                       CASE WHEN u.provider_org_id = ? THEN u.requester_org_id ELSE u.provider_org_id END, o.name,
                       u.capability, u.amount, u.currency, u.connection, u.completed_at
                FROM usage_records u
                JOIN organizations o ON o.id = CASE WHEN u.provider_org_id = ? THEN u.requester_org_id ELSE u.provider_org_id END
                WHERE (u.provider_org_id = ? OR u.requester_org_id = ?) AND u.completed_at >= ? AND u.completed_at < ?
                ORDER BY u.completed_at DESC LIMIT 500""",
                (rs, i) -> new UsageRecord(rs.getObject(1, UUID.class), rs.getString(2), rs.getObject(3, UUID.class), rs.getString(4),
                        rs.getString(5), rs.getBigDecimal(6), rs.getString(7), rs.getString(8), rs.getTimestamp(9).toInstant()),
                orgId, orgId, orgId, orgId, orgId, Timestamp.from(range[0]), Timestamp.from(range[1]));
        return new OrgUsage(period, totals, records);
    }

    /** What each provider is owed for a month, net of the platform fee, and whether it has been paid. */
    public List<PayoutLine> payouts(UserPrincipal admin, String period) {
        requireAdmin(admin);
        Instant[] range = range(period);
        return jdbc.query("""
                SELECT u.provider_org_id, o.name, u.currency, count(*), sum(u.amount),
                       count(*) FILTER (WHERE u.connection = 'relayed'),
                       p.id, p.net, p.reference, p.paid_by, p.paid_at
                FROM usage_records u
                JOIN organizations o ON o.id = u.provider_org_id
                LEFT JOIN payouts p ON p.org_id = u.provider_org_id AND p.period = ? AND p.currency = u.currency
                WHERE u.completed_at >= ? AND u.completed_at < ?
                GROUP BY u.provider_org_id, o.name, u.currency, p.id, p.net, p.reference, p.paid_by, p.paid_at
                ORDER BY o.name, u.currency""",
                (rs, i) -> {
                    BigDecimal gross = rs.getBigDecimal(5);
                    BigDecimal fee = fee(gross);
                    UUID paidId = rs.getObject(7, UUID.class);
                    Paid paid = paidId == null ? null
                            : new Paid(paidId, rs.getBigDecimal(8), rs.getString(9), rs.getString(10), rs.getTimestamp(11).toInstant());
                    return new PayoutLine(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3), rs.getLong(4), gross, fee,
                            gross.subtract(fee), rs.getLong(6), paid);
                },
                period, Timestamp.from(range[0]), Timestamp.from(range[1]));
    }

    /** Records that a payout was made outside the platform (bank transfer, etc.). Once per org, month and currency. */
    @Transactional
    public Paid markPaid(UserPrincipal admin, UUID orgId, String period, String currency, String reference) {
        requireAdmin(admin);
        if (reference == null || reference.isBlank()) {
            throw new ApiException.BadRequest("A payment reference is required");
        }
        PayoutLine line = payouts(admin, period).stream()
                .filter(l -> l.orgId().equals(orgId) && l.currency().equals(currency))
                .findFirst()
                .orElseThrow(() -> new ApiException.NotFound("Nothing is owed to this organization in " + currency + " for " + period));
        if (line.paid() != null) {
            throw new ApiException.Conflict("This payout is already recorded");
        }
        UUID id = UUID.randomUUID();
        Instant now = Instant.now();
        try {
            jdbc.update("""
                    INSERT INTO payouts (id, org_id, period, currency, tasks, gross, fee, net, reference, paid_by, paid_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    id, orgId, period, currency, line.tasks(), line.gross(), line.fee(), line.net(), reference.trim(), admin.email(),
                    Timestamp.from(now));
        } catch (DuplicateKeyException e) {
            throw new ApiException.Conflict("This payout is already recorded");
        }
        audit.record(null, "PAYOUT_RECORDED", "user:" + admin.email(), null, orgId, null, null,
                Map.of("period", period, "currency", currency, "tasks", line.tasks(), "gross", line.gross().toPlainString(),
                        "fee", line.fee().toPlainString(), "net", line.net().toPlainString(), "reference", reference.trim()));
        return new Paid(id, line.net(), reference.trim(), admin.email(), now);
    }

    public String payoutsCsv(UserPrincipal admin, String period) {
        StringBuilder csv = new StringBuilder("period,org_id,organization,currency,tasks,relayed_tasks,gross,fee,net,paid_reference,paid_at\n");
        for (PayoutLine l : payouts(admin, period)) {
            csv.append(String.join(",", period, l.orgId().toString(), csvField(l.orgName()), l.currency(), String.valueOf(l.tasks()),
                    String.valueOf(l.relayedTasks()), l.gross().toPlainString(), l.fee().toPlainString(), l.net().toPlainString(),
                    l.paid() == null ? "" : csvField(l.paid().reference()), l.paid() == null ? "" : l.paid().paidAt().toString())).append('\n');
        }
        return csv.toString();
    }

    BigDecimal fee(BigDecimal gross) {
        return gross.multiply(feePercent).divide(BigDecimal.valueOf(100), 2, RoundingMode.HALF_UP);
    }

    static Instant[] range(String period) {
        try {
            YearMonth month = YearMonth.parse(period == null ? "" : period);
            return new Instant[] {month.atDay(1).atStartOfDay(ZoneOffset.UTC).toInstant(),
                    month.plusMonths(1).atDay(1).atStartOfDay(ZoneOffset.UTC).toInstant()};
        } catch (DateTimeParseException e) {
            throw new ApiException.BadRequest("period must be a month like 2026-10");
        }
    }

    private static String csvField(String value) {
        // Quote, and neutralize a leading formula character so a spreadsheet does not execute it.
        String v = value == null ? "" : value;
        if (!v.isEmpty() && "=+-@".indexOf(v.charAt(0)) >= 0) {
            v = "'" + v;
        }
        return "\"" + v.replace("\"", "\"\"") + "\"";
    }

    private static void requireAdmin(UserPrincipal user) {
        if (!user.platformAdmin()) {
            throw new ApiException.Forbidden("This action requires a platform admin");
        }
    }
}
