package com.pistiva.platform.approval;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pistiva.platform.agent.Agent;
import com.pistiva.platform.agent.AgentRepository;
import com.pistiva.platform.audit.AuditService;
import com.pistiva.platform.common.ApiException;
import com.pistiva.platform.org.OrgMember.Role;
import com.pistiva.platform.org.OrgService;
import com.pistiva.platform.org.Organization;
import com.pistiva.platform.org.OrganizationRepository;
import com.pistiva.platform.security.Principals.AgentPrincipal;
import com.pistiva.platform.security.Principals.UserPrincipal;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Human approvals for commitments. An agent can ask; only a member of its own organization with
 * an approving role can decide. The decision is a deterministic gate in grant issuance, not advice.
 */
@Service
public class ApprovalService {

    /** Roles that may approve commitments on behalf of their organization. */
    public static final Set<Role> APPROVERS = Set.of(Role.OWNER, Role.ADMIN, Role.APPROVER);

    private final ApprovalRepository approvals;
    private final AgentRepository agents;
    private final OrganizationRepository orgs;
    private final OrgService orgService;
    private final AuditService audit;
    private final ObjectMapper mapper;

    public ApprovalService(ApprovalRepository approvals, AgentRepository agents, OrganizationRepository orgs,
                           OrgService orgService, AuditService audit, ObjectMapper mapper) {
        this.approvals = approvals;
        this.agents = agents;
        this.orgs = orgs;
        this.orgService = orgService;
        this.audit = audit;
        this.mapper = mapper;
    }

    public record ApprovalRequest(UUID providerAgentId, String capability, String reference, BigDecimal amount,
                                  String currency, JsonNode summary) {
    }

    @Transactional
    public Approval request(AgentPrincipal requester, ApprovalRequest req) {
        if (orgs.findById(requester.orgId()).filter(Organization::isTrusted).isEmpty()) {
            throw new ApiException.Forbidden("Requesting organization is not verified or is suspended");
        }
        Agent provider = agents.findById(req.providerAgentId())
                .orElseThrow(() -> new ApiException.NotFound("Unknown provider agent"));
        if (req.amount().signum() <= 0) {
            throw new ApiException.BadRequest("amount must be positive");
        }
        Approval approval = approvals.save(new Approval(requester.orgId(), requester.agentId(), provider.getId(),
                req.capability(), req.reference(), req.amount(), req.currency(), toJson(req.summary())));
        audit.record(null, "APPROVAL_REQUESTED", "agent:" + requester.agentId(), requester.orgId(), provider.getOrgId(),
                null, null, details(approval));
        return approval;
    }

    /** The requesting agent, or any member of the requesting organization, may read an approval. */
    public Approval get(Object caller, UUID id) {
        Approval a = approvals.findById(id).orElseThrow(() -> new ApiException.NotFound("Approval not found"));
        if (caller instanceof AgentPrincipal agent && agent.agentId().equals(a.getRequesterAgentId())) {
            return a;
        }
        if (caller instanceof UserPrincipal user) {
            orgService.requireMember(user, a.getOrgId());
            return a;
        }
        throw new ApiException.NotFound("Approval not found");
    }

    public List<Approval> list(UserPrincipal user, UUID orgId, Approval.Status status) {
        orgService.requireMember(user, orgId);
        return status == null ? approvals.findByOrgIdOrderByRequestedAtDesc(orgId)
                : approvals.findByOrgIdAndStatusOrderByRequestedAtDesc(orgId, status);
    }

    @Transactional
    public Approval decide(UserPrincipal user, UUID id, Approval.Status decision, String comment) {
        Approval a = approvals.findById(id).orElseThrow(() -> new ApiException.NotFound("Approval not found"));
        orgService.requireRole(user, a.getOrgId(), APPROVERS);
        if (decision == Approval.Status.PENDING) {
            throw new ApiException.BadRequest("decision must be APPROVED, REJECTED or CHANGES_REQUESTED");
        }
        if (a.getStatus() != Approval.Status.PENDING) {
            throw new ApiException.Conflict("Approval was already decided: " + a.getStatus());
        }
        if (decision != Approval.Status.APPROVED && (comment == null || comment.isBlank())) {
            throw new ApiException.BadRequest("A comment is required when rejecting or requesting changes");
        }
        a.decide(decision, user.userId(), comment == null ? null : comment.trim());
        Map<String, Object> d = details(a);
        d.put("decision", decision.name());
        d.put("decidedBy", user.userId().toString());
        if (comment != null && !comment.isBlank()) {
            d.put("comment", comment.trim());
        }
        UUID providerOrg = agents.findById(a.getProviderAgentId()).map(Agent::getOrgId).orElse(null);
        audit.record(null, "APPROVAL_DECIDED", "user:" + user.userId(), a.getOrgId(), providerOrg, null, null, d);
        return a;
    }

    private Map<String, Object> details(Approval a) {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("approvalId", a.getId().toString());
        d.put("capability", a.getCapability());
        d.put("reference", a.getReference());
        d.put("amount", a.getAmount().toPlainString());
        d.put("currency", a.getCurrency());
        return d;
    }

    private String toJson(JsonNode node) {
        if (node == null || node.isNull()) {
            return null;
        }
        try {
            return mapper.writeValueAsString(node);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
