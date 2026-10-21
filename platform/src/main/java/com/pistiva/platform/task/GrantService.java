package com.pistiva.platform.task;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pistiva.platform.PlatformProperties;
import com.pistiva.platform.agent.Agent;
import com.pistiva.platform.agent.AgentCard;
import com.pistiva.platform.agent.AgentCardRepository;
import com.pistiva.platform.agent.AgentRepository;
import com.pistiva.platform.audit.AuditService;
import com.pistiva.platform.common.ApiException;
import com.pistiva.platform.identity.PlatformKeyService;
import com.pistiva.platform.org.Organization;
import com.pistiva.platform.org.OrganizationRepository;
import com.pistiva.platform.policy.PolicyRules;
import com.pistiva.platform.policy.PolicyService;
import com.pistiva.platform.policy.RateLimiter;
import com.pistiva.platform.security.Principals.AgentPrincipal;
import com.pistiva.platform.tasktype.TaskTypeService;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * The platform half of the two-layer policy check. Every task starts with a grant: a short-lived
 * token, signed by the platform, that names exactly one requester, one provider, one capability
 * and a budget. Decisions here are deterministic; no model output is consulted.
 */
@Service
public class GrantService {

    public static final String GRANT_TYP = "pistiva-grant+jwt";

    private final AgentRepository agents;
    private final AgentCardRepository cards;
    private final OrganizationRepository orgs;
    private final PolicyService policies;
    private final RateLimiter rateLimiter;
    private final TaskGrantRepository grants;
    private final PlatformKeyService platformKeys;
    private final PlatformProperties props;
    private final AuditService audit;
    private final TaskTypeService taskTypes;
    private final ObjectMapper mapper;

    public GrantService(AgentRepository agents, AgentCardRepository cards, OrganizationRepository orgs,
                        PolicyService policies, RateLimiter rateLimiter, TaskGrantRepository grants,
                        PlatformKeyService platformKeys, PlatformProperties props, AuditService audit,
                        TaskTypeService taskTypes, ObjectMapper mapper) {
        this.agents = agents;
        this.cards = cards;
        this.orgs = orgs;
        this.policies = policies;
        this.rateLimiter = rateLimiter;
        this.grants = grants;
        this.platformKeys = platformKeys;
        this.props = props;
        this.audit = audit;
        this.taskTypes = taskTypes;
        this.mapper = mapper;
    }

    /** @param continueTaskId set to extend an existing task (e.g. a long clarification round) under a fresh grant */
    public record GrantRequest(UUID providerAgentId, String capability, BigDecimal budget, String currency, UUID continueTaskId) {
    }

    public record IssuedGrant(UUID taskId, UUID jti, String grant, Instant expiresAt, boolean approvalRequired) {
    }

    public IssuedGrant issue(AgentPrincipal requester, GrantRequest req) {
        TaskGrant previous = req.continueTaskId() == null ? null
                : grants.findFirstByTaskIdOrderByCreatedAtDesc(req.continueTaskId()).orElse(null);
        UUID taskId = req.continueTaskId() == null ? UUID.randomUUID() : req.continueTaskId();
        Agent provider = agents.findById(req.providerAgentId()).orElse(null);
        UUID providerOrgId = provider == null ? null : provider.getOrgId();
        Decision decision = new Decision(taskId, requester, providerOrgId, req);

        if (req.continueTaskId() != null) {
            if (previous == null || !previous.getRequesterAgentId().equals(requester.agentId())
                    || !previous.getProviderAgentId().equals(req.providerAgentId())
                    || !previous.getCapability().equals(req.capability())) {
                throw decision.deny("No matching task to continue");
            }
            if (previous.getStatus() == TaskGrant.Status.COMPLETED) {
                throw decision.deny("Task is already completed");
            }
            if (req.budget().compareTo(previous.getBudget()) > 0 || !previous.getCurrency().equals(req.currency())) {
                throw decision.deny("A continued task cannot raise its budget or change currency");
            }
        }
        Organization requesterOrg = orgs.findById(requester.orgId()).orElseThrow();
        if (!requesterOrg.isTrusted()) {
            throw decision.deny("Requesting organization is not verified or is suspended");
        }
        PolicyRules rules = policies.get(requester.orgId());
        if (!rateLimiter.tryAcquire(requester.agentId(), rules.rateLimitPerMinute())) {
            throw decision.deny("Rate limit exceeded");
        }
        if (provider == null || !provider.isActive()) {
            throw decision.deny("Provider agent is unknown or suspended");
        }
        if (provider.getId().equals(requester.agentId())) {
            throw decision.deny("An agent cannot grant itself a task");
        }
        if (orgs.findById(provider.getOrgId()).filter(Organization::isTrusted).isEmpty()) {
            throw decision.deny("Provider organization is not verified or is suspended");
        }
        JsonNode capability = findCapability(provider.getId(), req.capability());
        if (capability == null) {
            throw decision.deny("Provider does not offer capability " + req.capability());
        }
        if (!rules.allowedCapabilities().contains(req.capability())) {
            throw decision.deny("Capability " + req.capability() + " is not allowed by your organization's policy");
        }
        if (!rules.currency().equals(req.currency())) {
            throw decision.deny("Currency must be " + rules.currency());
        }
        if (req.budget().signum() < 0 || req.budget().compareTo(rules.maxBudgetPerTask()) > 0) {
            throw decision.deny("Budget " + req.budget() + " exceeds the per-task limit of " + rules.maxBudgetPerTask());
        }

        int taskTypeVersion = capability.path("version").asInt(1);
        boolean approvalRequired = req.budget().compareTo(rules.approvalThreshold()) > 0;
        Instant now = Instant.now();
        Instant expiresAt = now.plus(props.grantTtl());
        TaskGrant grant = grants.save(new TaskGrant(taskId, requester.agentId(), provider.getId(), req.capability(),
                taskTypeVersion, req.budget(), req.currency(), approvalRequired, expiresAt,
                previous == null ? null : previous.getJti()));

        ObjectNode claims = mapper.createObjectNode()
                .put("iss", props.issuer())
                .put("sub", requester.agentId().toString())
                .put("aud", provider.getId().toString())
                .put("jti", grant.getJti().toString())
                .put("tid", taskId.toString())
                .put("cap", req.capability())
                .put("ttv", taskTypeVersion)
                .put("bud", req.budget().toPlainString())
                .put("cur", req.currency())
                .put("apr", approvalRequired)
                .put("rorg", requester.orgId().toString())
                .put("porg", provider.getOrgId().toString())
                .put("iat", now.getEpochSecond())
                .put("exp", expiresAt.getEpochSecond());
        ArrayNode fields = claims.putArray("fld");
        disclosableFields(capability, req.capability(), taskTypeVersion).forEach(fields::add);

        audit.record(taskId, "GRANT_ISSUED", "agent:" + requester.agentId(), requester.orgId(), provider.getOrgId(),
                null, null, Map.of("jti", grant.getJti(), "capability", req.capability() + "@" + taskTypeVersion,
                        "budget", req.budget().toPlainString(), "approvalRequired", approvalRequired));
        return new IssuedGrant(taskId, grant.getJti(), platformKeys.sign(GRANT_TYP, claims), expiresAt, approvalRequired);
    }

    /**
     * The fields the provider may disclose: those its card lists, or else every property of the
     * contract's result schema. The provider's gateway narrows this further with its local allowlist.
     */
    private List<String> disclosableFields(JsonNode capability, String name, int version) {
        List<String> out = new ArrayList<>();
        JsonNode listed = capability.path("responseFields");
        if (listed.isArray() && !listed.isEmpty()) {
            listed.forEach(f -> out.add(f.asText()));
        } else {
            taskTypes.get(name, version).messages().path("result").path("properties").fieldNames().forEachRemaining(out::add);
        }
        return out;
    }

    private JsonNode findCapability(UUID agentId, String name) {
        AgentCard card = cards.findById(agentId).orElse(null);
        if (card == null) {
            return null;
        }
        try {
            for (JsonNode c : mapper.readTree(card.getCardJson()).path("capabilities")) {
                if (name.equals(c.path("name").asText())) {
                    return c;
                }
            }
        } catch (Exception e) {
            return null;
        }
        return null;
    }

    /** Audits a denial with its reason and aborts the request with 403. */
    private final class Decision {
        private final UUID taskId;
        private final AgentPrincipal requester;
        private final UUID providerOrgId;
        private final GrantRequest req;

        Decision(UUID taskId, AgentPrincipal requester, UUID providerOrgId, GrantRequest req) {
            this.taskId = taskId;
            this.requester = requester;
            this.providerOrgId = providerOrgId;
            this.req = req;
        }

        ApiException deny(String reason) {
            Map<String, Object> details = new LinkedHashMap<>();
            details.put("reason", reason);
            details.put("providerAgentId", String.valueOf(req.providerAgentId()));
            details.put("capability", req.capability());
            details.put("budget", req.budget().toPlainString());
            audit.record(taskId, "GRANT_DENIED", "agent:" + requester.agentId(), requester.orgId(), providerOrgId,
                    null, null, details);
            return new ApiException.PolicyDenied(reason);
        }
    }
}
