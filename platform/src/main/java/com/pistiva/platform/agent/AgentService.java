package com.pistiva.platform.agent;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pistiva.platform.audit.AuditService;
import com.pistiva.platform.common.ApiException;
import com.pistiva.platform.common.Ed25519;
import com.pistiva.platform.common.Jcs;
import com.pistiva.platform.identity.KeyIds;
import com.pistiva.platform.org.OrgMember.Role;
import com.pistiva.platform.org.OrgService;
import com.pistiva.platform.org.Organization;
import com.pistiva.platform.policy.PolicyRules;
import com.pistiva.platform.security.Principals.AgentPrincipal;
import com.pistiva.platform.security.Principals.UserPrincipal;
import com.pistiva.platform.tasktype.TaskTypeService;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@Service
public class AgentService {

    private final AgentRepository agents;
    private final AgentKeyRepository keys;
    private final AgentCardRepository cards;
    private final AgentCapabilityRepository capabilities;
    private final OrgService orgService;
    private final AuditService audit;
    private final TaskTypeService taskTypes;
    private final ObjectMapper mapper;

    public AgentService(AgentRepository agents, AgentKeyRepository keys, AgentCardRepository cards,
                        AgentCapabilityRepository capabilities, OrgService orgService, AuditService audit,
                        TaskTypeService taskTypes, ObjectMapper mapper) {
        this.agents = agents;
        this.keys = keys;
        this.cards = cards;
        this.capabilities = capabilities;
        this.orgService = orgService;
        this.audit = audit;
        this.taskTypes = taskTypes;
        this.mapper = mapper;
    }

    public record KeyView(String kid, String publicKey, boolean revoked) {
        static KeyView of(AgentKey k) {
            return new KeyView(k.getKid(), k.getPublicKey(), k.isRevoked());
        }
    }

    /** What a gateway needs to verify a peer: its status, its org's trust and its keys. */
    public record AgentStatus(UUID agentId, UUID orgId, String status, boolean orgTrusted, List<KeyView> keys) {
    }

    public Agent get(UUID agentId) {
        return agents.findById(agentId).orElseThrow(() -> new ApiException.NotFound("Agent not found"));
    }

    @Transactional
    public Agent create(UserPrincipal user, UUID orgId, String name, String version, String endpointUrl) {
        orgService.requireRole(user, orgId, Role.MANAGE_AGENTS);
        validateEndpoint(endpointUrl);
        Agent agent = agents.save(new Agent(orgId, name, version, endpointUrl).createdBy(user.userId()));
        audit.record("AGENT_CREATED", "user:" + user.userId(), orgId, Map.of("agentId", agent.getId()));
        return agent;
    }

    public List<Agent> list(UserPrincipal user, UUID orgId) {
        orgService.requireMember(user, orgId);
        return agents.findByOrgId(orgId);
    }

    public List<AgentKey> listKeys(UserPrincipal user, UUID agentId) {
        Agent agent = get(agentId);
        orgService.requireMember(user, agent.getOrgId());
        return keys.findByAgentId(agentId);
    }

    @Transactional
    public AgentKey addKey(UserPrincipal user, UUID agentId, String publicKey) {
        Agent agent = get(agentId);
        orgService.requireRole(user, agent.getOrgId(), Role.MANAGE_AGENTS);
        try {
            Ed25519.publicKeyFromRaw(publicKey);
        } catch (IllegalArgumentException e) {
            throw new ApiException.BadRequest("publicKey must be a base64url-encoded 32-byte Ed25519 key");
        }
        String kid = KeyIds.thumbprint(publicKey);
        if (keys.existsById(kid)) {
            throw new ApiException.Conflict("Key already registered");
        }
        AgentKey key = keys.save(new AgentKey(kid, agentId, publicKey));
        audit.record("AGENT_KEY_ADDED", "user:" + user.userId(), agent.getOrgId(), Map.of("agentId", agentId, "kid", kid));
        return key;
    }

    @Transactional
    public AgentKey revokeKey(UserPrincipal user, UUID agentId, String kid) {
        Agent agent = get(agentId);
        orgService.requireRole(user, agent.getOrgId(), Role.MANAGE_AGENTS);
        AgentKey key = keys.findById(kid).filter(k -> k.getAgentId().equals(agentId))
                .orElseThrow(() -> new ApiException.NotFound("Key not found"));
        key.revoke();
        audit.record("AGENT_KEY_REVOKED", "user:" + user.userId(), agent.getOrgId(), Map.of("agentId", agentId, "kid", kid));
        return key;
    }

    /** Suspension is the kill switch: a suspended agent cannot authenticate or be granted tasks. */
    @Transactional
    public Agent setStatus(UserPrincipal user, UUID agentId, Agent.Status status) {
        Agent agent = get(agentId);
        orgService.requireRole(user, agent.getOrgId(), Role.MANAGE_ORG);
        agent.setStatus(status);
        audit.record("AGENT_STATUS_CHANGED", "user:" + user.userId(), agent.getOrgId(),
                Map.of("agentId", agentId, "status", status.name()));
        return agent;
    }

    /**
     * Publishes a signed agent card. Either an org member with agent rights, or the agent itself,
     * may publish. The signature must verify against a live key registered to this agent.
     */
    @Transactional
    public AgentCard publishCard(Object caller, UUID agentId, JsonNode card, String kid, String signature) {
        Agent agent = get(agentId);
        String actor;
        if (caller instanceof UserPrincipal user) {
            orgService.requireRole(user, agent.getOrgId(), Role.MANAGE_AGENTS);
            actor = "user:" + user.userId();
        } else if (caller instanceof AgentPrincipal self && self.agentId().equals(agentId)) {
            actor = "agent:" + agentId;
        } else {
            throw new ApiException.Forbidden("Only the agent or its organization can publish its card");
        }

        AgentKey key = keys.findById(kid).filter(k -> k.getAgentId().equals(agentId) && !k.isRevoked())
                .orElseThrow(() -> new ApiException.BadRequest("kid is not a live key of this agent"));
        byte[] canonical;
        try {
            canonical = Jcs.canonicalize(card);
        } catch (IllegalArgumentException e) {
            throw new ApiException.BadRequest(e.getMessage());
        }
        byte[] sig;
        try {
            sig = Ed25519.b64urlDecode(signature);
        } catch (IllegalArgumentException e) {
            throw new ApiException.BadRequest("signature must be base64url");
        }
        if (!Ed25519.verify(Ed25519.publicKeyFromRaw(key.getPublicKey()), canonical, sig)) {
            throw new ApiException.BadRequest("Card signature does not verify");
        }

        ParsedCard parsed = validateCard(card, agent, kid);
        agent.updateFromCard(parsed.name(), parsed.version(), parsed.endpoint());
        AgentCard stored = cards.findById(agentId).orElseGet(() -> new AgentCard(agentId));
        stored.publish(new String(canonical, StandardCharsets.UTF_8), signature, kid);
        cards.save(stored);

        capabilities.deleteByAgentId(agentId);
        capabilities.flush();
        for (ParsedCapability c : parsed.capabilities()) {
            capabilities.save(new AgentCapability(agentId, c.name(), c.taskTypeVersion(), c.priceJson()));
        }
        audit.record("AGENT_CARD_PUBLISHED", actor, agent.getOrgId(),
                Map.of("agentId", agentId, "kid", kid, "capabilities", parsed.capabilities().stream().map(ParsedCapability::name).toList()));
        return stored;
    }

    public AgentStatus status(UUID agentId) {
        Agent agent = get(agentId);
        Organization org = orgService.get(agent.getOrgId());
        return new AgentStatus(agentId, agent.getOrgId(), agent.getStatus().name(), org.isTrusted(),
                keys.findByAgentId(agentId).stream().map(KeyView::of).toList());
    }

    record ParsedCapability(String name, int taskTypeVersion, String priceJson) {
    }

    record ParsedCard(String name, String version, String endpoint, List<ParsedCapability> capabilities) {
    }

    private ParsedCard validateCard(JsonNode card, Agent agent, String kid) {
        if (!agent.getId().toString().equals(card.path("agentId").asText())) {
            throw new ApiException.BadRequest("card.agentId does not match");
        }
        if (!agent.getOrgId().toString().equals(card.path("orgId").asText())) {
            throw new ApiException.BadRequest("card.orgId does not match the agent's organization");
        }
        if (!kid.equals(card.path("kid").asText())) {
            throw new ApiException.BadRequest("card.kid does not match the signing key");
        }
        String name = requireText(card, "name");
        String version = requireText(card, "version");
        String endpoint = requireText(card, "endpoint");
        validateEndpoint(endpoint);
        JsonNode caps = card.path("capabilities");
        if (!caps.isArray() || caps.isEmpty()) {
            throw new ApiException.BadRequest("card.capabilities must be a non-empty array");
        }
        Set<String> seen = new HashSet<>();
        List<ParsedCapability> parsed = new ArrayList<>();
        for (JsonNode c : caps) {
            String capName = c.path("name").asText();
            if (!capName.matches(PolicyRules.CAPABILITY_PATTERN) || !seen.add(capName)) {
                throw new ApiException.BadRequest("Invalid or duplicate capability name: " + capName);
            }
            // Cards may only advertise registered contracts, so both sides agree on message shapes.
            int taskTypeVersion = c.path("version").asInt(0);
            if (!taskTypes.exists(capName, taskTypeVersion)) {
                throw new ApiException.BadRequest("Capability " + capName + "@" + taskTypeVersion + " is not a registered task type version");
            }
            JsonNode price = c.path("price");
            parsed.add(new ParsedCapability(capName, taskTypeVersion, price.isMissingNode() ? null : toJson(price)));
        }
        return new ParsedCard(name, version, endpoint, parsed);
    }

    private static String requireText(JsonNode card, String field) {
        String value = card.path(field).asText("");
        if (value.isBlank()) {
            throw new ApiException.BadRequest("card." + field + " is required");
        }
        return value;
    }

    private static void validateEndpoint(String endpoint) {
        URI uri;
        try {
            uri = URI.create(endpoint);
        } catch (IllegalArgumentException e) {
            throw new ApiException.BadRequest("Invalid endpoint URL");
        }
        if (uri.getHost() == null || !("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))) {
            throw new ApiException.BadRequest("Endpoint must be an http(s) URL");
        }
    }

    private String toJson(JsonNode node) {
        try {
            return mapper.writeValueAsString(node);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
