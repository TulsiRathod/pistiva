package com.pistiva.platform.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pistiva.platform.org.Organization;
import com.pistiva.platform.org.OrganizationRepository;
import com.pistiva.platform.security.Principals;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Capability search. Only active agents of verified, active organizations with a card signed by a
 * live key are returned. The signed card is included so the caller can verify it independently.
 */
@RestController
public class DiscoveryController {

    private final AgentCapabilityRepository capabilities;
    private final AgentRepository agents;
    private final AgentCardRepository cards;
    private final AgentKeyRepository keys;
    private final OrganizationRepository orgs;
    private final ObjectMapper mapper;

    public DiscoveryController(AgentCapabilityRepository capabilities, AgentRepository agents, AgentCardRepository cards,
                               AgentKeyRepository keys, OrganizationRepository orgs, ObjectMapper mapper) {
        this.capabilities = capabilities;
        this.agents = agents;
        this.cards = cards;
        this.keys = keys;
        this.orgs = orgs;
        this.mapper = mapper;
    }

    public record DiscoveredAgent(UUID agentId, UUID orgId, String orgName, String orgDomain, boolean orgVerified,
                                  JsonNode card, String kid, String signature, String publicKey) {
    }

    @GetMapping("/discovery")
    public List<DiscoveredAgent> discover(@RequestParam String capability) {
        Principals.current();
        return capabilities.findByCapability(capability).stream()
                .map(c -> toDiscovered(c.getAgentId()))
                .flatMap(Optional::stream)
                .toList();
    }

    private Optional<DiscoveredAgent> toDiscovered(UUID agentId) {
        Agent agent = agents.findById(agentId).filter(Agent::isActive).orElse(null);
        if (agent == null) {
            return Optional.empty();
        }
        Organization org = orgs.findById(agent.getOrgId()).filter(Organization::isTrusted).orElse(null);
        AgentCard card = cards.findById(agentId).orElse(null);
        if (org == null || card == null) {
            return Optional.empty();
        }
        AgentKey key = keys.findById(card.getKid()).filter(k -> !k.isRevoked()).orElse(null);
        if (key == null) {
            return Optional.empty();
        }
        try {
            JsonNode cardJson = mapper.readTree(card.getCardJson());
            return Optional.of(new DiscoveredAgent(agentId, org.getId(), org.getName(), org.getDomain(), true,
                    cardJson, key.getKid(), card.getSignature(), key.getPublicKey()));
        } catch (Exception e) {
            return Optional.empty();
        }
    }
}
