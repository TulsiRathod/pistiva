package com.pistiva.platform.certification;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pistiva.platform.agent.Agent;
import com.pistiva.platform.agent.AgentRepository;
import com.pistiva.platform.audit.AuditService;
import com.pistiva.platform.common.ApiException;
import com.pistiva.platform.common.Jcs;
import com.pistiva.platform.org.Organization;
import com.pistiva.platform.org.OrganizationRepository;
import com.pistiva.platform.org.OrgService;
import com.pistiva.platform.security.Principals.AgentPrincipal;
import com.pistiva.platform.security.Principals.UserPrincipal;
import com.pistiva.platform.tasktype.TaskTypeService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Records conformance-suite results per (agent, task-type version). Only agents of organizations an
 * admin has marked as certifiers may submit; the verdict is recomputed from the report's checks, so a
 * report cannot claim to pass with a failing check. The most recent run decides an agent's status.
 */
@Service
public class CertificationService {

    public enum Status { PASSED, FAILED, REVOKED }

    private final JdbcTemplate jdbc;
    private final AgentRepository agents;
    private final OrganizationRepository orgs;
    private final OrgService orgService;
    private final TaskTypeService taskTypes;
    private final AuditService audit;
    private final ObjectMapper mapper;
    private final Duration validity;
    private volatile boolean required;

    public CertificationService(JdbcTemplate jdbc, AgentRepository agents, OrganizationRepository orgs, OrgService orgService,
                                TaskTypeService taskTypes, AuditService audit, ObjectMapper mapper,
                                @Value("${pistiva.certification.validity:365d}") Duration validity,
                                @Value("${pistiva.certification.required:false}") boolean required) {
        this.jdbc = jdbc;
        this.agents = agents;
        this.orgs = orgs;
        this.orgService = orgService;
        this.taskTypes = taskTypes;
        this.audit = audit;
        this.mapper = mapper;
        this.validity = validity;
        this.required = required;
    }

    public record Certification(UUID id, UUID agentId, UUID orgId, String taskType, int taskTypeVersion, Status status,
                                boolean valid, String suiteVersion, int checksPassed, int checksTotal, String reportHash,
                                UUID certifierAgentId, Instant createdAt, Instant expiresAt, Instant revokedAt,
                                String revokedReason, JsonNode report) {
    }

    /** True when discovery and grants only admit certified providers. */
    public boolean required() {
        return required;
    }

    @Transactional
    public Certification submit(AgentPrincipal certifier, UUID agentId, JsonNode report) {
        Organization certifierOrg = orgs.findById(certifier.orgId()).orElseThrow();
        if (!certifierOrg.isCertifier() || !certifierOrg.isTrusted()) {
            throw new ApiException.Forbidden("Only agents of a certifier organization can submit conformance results");
        }
        Agent target = agents.findById(agentId).orElseThrow(() -> new ApiException.NotFound("Agent not found"));
        if (target.getOrgId().equals(certifier.orgId())) {
            throw new ApiException.Forbidden("A certifier cannot certify its own organization's agents");
        }
        if (report == null || !agentId.toString().equals(report.path("agentId").asText())) {
            throw new ApiException.BadRequest("report.agentId must match the agent being certified");
        }
        String taskType = report.path("capability").asText("");
        int version = report.path("taskTypeVersion").asInt(0);
        if (!taskTypes.exists(taskType, version)) {
            throw new ApiException.BadRequest("report names an unknown task type " + taskType + "@" + version);
        }
        String suiteVersion = report.path("suiteVersion").asText("");
        JsonNode checks = report.path("checks");
        if (suiteVersion.isBlank() || !checks.isArray() || checks.isEmpty()) {
            throw new ApiException.BadRequest("report needs a suiteVersion and a non-empty checks array");
        }
        int passed = 0;
        for (JsonNode check : checks) {
            if (check.path("passed").asBoolean(false)) {
                passed++;
            }
        }
        Status status = passed == checks.size() ? Status.PASSED : Status.FAILED;
        UUID id = UUID.randomUUID();
        Instant now = Instant.now();
        Instant expiresAt = now.plus(validity);
        String reportJson = report.toString();
        String reportHash = sha256Hex(Jcs.canonicalize(report));
        jdbc.update("""
                INSERT INTO certifications (id, agent_id, org_id, task_type, task_type_version, status, suite_version,
                  checks_passed, checks_total, report_json, report_hash, certifier_agent_id, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                id, agentId, target.getOrgId(), taskType, version, status.name(), suiteVersion, passed, checks.size(),
                reportJson, reportHash, certifier.agentId(), Timestamp.from(now), Timestamp.from(expiresAt));

        Map<String, Object> details = new LinkedHashMap<>();
        details.put("certificationId", id.toString());
        details.put("agentId", agentId.toString());
        details.put("taskType", taskType + "@" + version);
        details.put("checks", passed + "/" + checks.size());
        details.put("reportHash", reportHash);
        audit.record(null, status == Status.PASSED ? "AGENT_CERTIFIED" : "CERTIFICATION_FAILED", "agent:" + certifier.agentId(),
                certifier.orgId(), target.getOrgId(), null, null, details);
        return get(id, true);
    }

    /** The latest result per task-type version for one agent. */
    public List<Certification> forAgent(UUID agentId) {
        return jdbc.query(SELECT + " " + """
                WHERE c.id IN (SELECT DISTINCT ON (task_type, task_type_version) id FROM certifications
                               WHERE agent_id = ? ORDER BY task_type, task_type_version, created_at DESC)
                ORDER BY c.task_type, c.task_type_version""", rowMapper(false), agentId);
    }

    /** Whether the agent's latest run for this task-type version passed and has not expired or been revoked. */
    public boolean isCertified(UUID agentId, String taskType, int version) {
        Boolean valid = jdbc.query("""
                SELECT status = 'PASSED' AND expires_at > now() FROM certifications
                WHERE agent_id = ? AND task_type = ? AND task_type_version = ?
                ORDER BY created_at DESC LIMIT 1""",
                rs -> rs.next() ? rs.getBoolean(1) : Boolean.FALSE, agentId, taskType, version);
        return Boolean.TRUE.equals(valid);
    }

    /** Certifier organizations reach uncertified agents too; certifying them would be impossible otherwise. */
    public boolean isCertifierOrg(UUID orgId) {
        return orgId != null && orgs.findById(orgId).map(Organization::isCertifier).orElse(false);
    }

    /** With the report: for platform admins, the certified organization and the certifier. */
    public Certification report(UserPrincipal user, UUID id) {
        Certification c = get(id, true);
        if (!user.platformAdmin()) {
            orgService.requireMember(user, c.orgId());
        }
        return c;
    }

    public List<Certification> latest(UserPrincipal admin, int limit) {
        requireAdmin(admin);
        return jdbc.query(SELECT + " ORDER BY c.created_at DESC LIMIT ?", rowMapper(false), Math.max(1, Math.min(limit, 500)));
    }

    @Transactional
    public Certification revoke(UserPrincipal admin, UUID id, String reason) {
        requireAdmin(admin);
        if (reason == null || reason.isBlank()) {
            throw new ApiException.BadRequest("A reason is required to revoke a certification");
        }
        Certification c = get(id, false);
        if (c.status() == Status.REVOKED) {
            throw new ApiException.Conflict("Certification is already revoked");
        }
        jdbc.update("UPDATE certifications SET status = 'REVOKED', revoked_at = now(), revoked_reason = ? WHERE id = ?", reason, id);
        audit.record(null, "CERTIFICATION_REVOKED", "user:" + admin.email(), c.orgId(), null, null, null,
                Map.of("certificationId", id.toString(), "agentId", c.agentId().toString(),
                        "taskType", c.taskType() + "@" + c.taskTypeVersion(), "reason", reason));
        return get(id, false);
    }

    @Transactional
    public Organization setCertifier(UserPrincipal admin, UUID orgId, boolean certifier) {
        requireAdmin(admin);
        Organization org = orgService.get(orgId);
        org.setCertifier(certifier);
        orgs.save(org);
        audit.record("ORG_CERTIFIER_CHANGED", "user:" + admin.email(), orgId, Map.of("certifier", certifier));
        return org;
    }

    private Certification get(UUID id, boolean withReport) {
        List<Certification> found = jdbc.query(SELECT + " WHERE c.id = ?", rowMapper(withReport), id);
        if (found.isEmpty()) {
            throw new ApiException.NotFound("Certification not found");
        }
        return found.get(0);
    }

    private static final String SELECT = """
            SELECT c.id, c.agent_id, c.org_id, c.task_type, c.task_type_version, c.status, c.suite_version, c.checks_passed,
                   c.checks_total, c.report_hash, c.certifier_agent_id, c.created_at, c.expires_at, c.revoked_at,
                   c.revoked_reason, c.report_json
            FROM certifications c""";

    private RowMapper<Certification> rowMapper(boolean withReport) {
        return (rs, i) -> {
            Status status = Status.valueOf(rs.getString(6));
            Instant expiresAt = rs.getTimestamp(13).toInstant();
            Timestamp revokedAt = rs.getTimestamp(14);
            JsonNode report = null;
            if (withReport) {
                try {
                    report = mapper.readTree(rs.getString(16));
                } catch (Exception e) {
                    throw new IllegalStateException(e);
                }
            }
            return new Certification(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getObject(3, UUID.class),
                    rs.getString(4), rs.getInt(5), status, status == Status.PASSED && expiresAt.isAfter(Instant.now()),
                    rs.getString(7), rs.getInt(8), rs.getInt(9), rs.getString(10), rs.getObject(11, UUID.class),
                    rs.getTimestamp(12).toInstant(), expiresAt, revokedAt == null ? null : revokedAt.toInstant(),
                    rs.getString(15), report);
        };
    }

    private static void requireAdmin(UserPrincipal user) {
        if (!user.platformAdmin()) {
            throw new ApiException.Forbidden("This action requires a platform admin");
        }
    }

    private static String sha256Hex(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
