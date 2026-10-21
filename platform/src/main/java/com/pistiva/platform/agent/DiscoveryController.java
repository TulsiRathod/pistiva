package com.pistiva.platform.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pistiva.platform.certification.CertificationService;
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
 * Each result says whether the agent is certified for the version of the capability it advertises;
 * when certification is required, uncertified agents are hidden from everyone but certifiers and admins.
 */
@RestController
public class DiscoveryController {

    private final AgentCapabilityRepository capabilities;
    private final AgentRepository agents;
    private final AgentCardRepository cards;
    private final AgentKeyRepository keys;
    private final OrganizationRepository orgs;
    private final ObjectMapper mapper;
    private final CertificationService certifications;

    public DiscoveryController(AgentCapabilityRepository capabilities, AgentRepository agents, AgentCardRepository cards,
                               AgentKeyRepository keys, OrganizationRepository orgs, ObjectMapper mapper,
                               CertificationService certifications) {
        this.capabilities = capabilities;
        this.agents = agents;
        this.cards = cards;
        this.keys = keys;
        this.orgs = orgs;
        this.mapper = mapper;
        this.certifications = certifications;
    }

    public record DiscoveredAgent(UUID agentId, UUID orgId, String orgName, String orgDomain, boolean orgVerified,
                                  JsonNode card, String kid, String signature, String publicKey, boolean certified) {
    }

    @GetMapping("/discovery")
    public List<DiscoveredAgent> discover(@RequestParam String capability,
                                          @RequestParam(defaultValue = "false") boolean certifiedOnly) {
        boolean onlyCertified = certifiedOnly || (certifications.required() && !seesUncertified(Principals.current()));
        return capabilities.findByCapability(capability).stream()
                .map(c -> toDiscovered(c.getAgentId(), capability))
                .flatMap(Optional::stream)
                .filter(d -> d.certified() || !onlyCertified)
                .toList();
    }

    private boolean seesUncertified(Object principal) {
        if (principal instanceof Principals.AgentPrincipal agent) {
            return certifications.isCertifierOrg(agent.orgId());
        }
        return principal instanceof Principals.UserPrincipal user && user.platformAdmin();
    }

    private Optional<DiscoveredAgent> toDiscovered(UUID agentId, String capability) {
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
            int version = 1;
            for (JsonNode c : cardJson.path("capabilities")) {
                if (capability.equals(c.path("name").asText())) {
                    version = c.path("version").asInt(1);
                }
            }
            return Optional.of(new DiscoveredAgent(agentId, org.getId(), org.getName(), org.getDomain(), true,
                    cardJson, key.getKid(), card.getSignature(), key.getPublicKey(),
                    certifications.isCertified(agentId, capability, version)));
        } catch (Exception e) {
            return Optional.empty();
        }
    }
}
