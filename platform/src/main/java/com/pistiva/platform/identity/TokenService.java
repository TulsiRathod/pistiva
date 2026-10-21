package com.pistiva.platform.identity;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pistiva.platform.PlatformProperties;
import com.pistiva.platform.agent.Agent;
import com.pistiva.platform.agent.AgentKey;
import com.pistiva.platform.agent.AgentKeyRepository;
import com.pistiva.platform.agent.AgentRepository;
import com.pistiva.platform.common.ApiException;
import com.pistiva.platform.common.Ed25519;
import com.pistiva.platform.common.Jws;
import com.pistiva.platform.common.ReplayStore;
import com.pistiva.platform.org.User;
import com.pistiva.platform.security.Principals.AgentPrincipal;
import com.pistiva.platform.security.Principals.UserPrincipal;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.UUID;

/**
 * Issues console access tokens and verifies both kinds of bearer token:
 * {@code pistiva-user+jwt} signed by the platform, and {@code pistiva-agent+jwt} assertions signed by an agent key.
 */
@Service
public class TokenService {

    public static final String USER_TYP = "pistiva-user+jwt";
    public static final String AGENT_TYP = "pistiva-agent+jwt";

    private final PlatformKeyService platformKeys;
    private final PlatformProperties props;
    private final AgentKeyRepository agentKeys;
    private final AgentRepository agents;
    private final ObjectMapper mapper = new ObjectMapper();
    private final ReplayStore assertionReplay;

    public TokenService(PlatformKeyService platformKeys, PlatformProperties props,
                        AgentKeyRepository agentKeys, AgentRepository agents, ReplayStore assertionReplay) {
        this.assertionReplay = assertionReplay;
        this.platformKeys = platformKeys;
        this.props = props;
        this.agentKeys = agentKeys;
        this.agents = agents;
    }

    public String issueUserToken(User user) {
        long now = Instant.now().getEpochSecond();
        ObjectNode claims = mapper.createObjectNode()
                .put("iss", props.issuer())
                .put("sub", user.getId().toString())
                .put("email", user.getEmail())
                .put("adm", user.isPlatformAdmin())
                .put("iat", now)
                .put("exp", now + props.userTokenTtl().toSeconds());
        return platformKeys.sign(USER_TYP, claims);
    }

    public String typeOf(String token) {
        try {
            JsonNode header = mapper.readTree(Ed25519.b64urlDecode(token.substring(0, token.indexOf('.'))));
            return header.path("typ").asText();
        } catch (Exception e) {
            throw new ApiException.Unauthorized("Malformed token");
        }
    }

    public UserPrincipal verifyUserToken(String token) {
        Jws.Parsed parsed = Jws.verify(token, USER_TYP,
                header -> platformKeys.kid().equals(header.path("kid").asText()) ? platformKeys.publicKey() : null);
        JsonNode claims = parsed.payload();
        if (!props.issuer().equals(claims.path("iss").asText())) {
            throw new ApiException.Unauthorized("Wrong issuer");
        }
        return new UserPrincipal(UUID.fromString(claims.path("sub").asText()),
                claims.path("email").asText(), claims.path("adm").asBoolean());
    }

    /**
     * Agent assertion: iss = agent id, aud = platform issuer, short lifetime and single use.
     * The key must be registered to that agent, not revoked, and the agent must not be suspended.
     */
    public AgentPrincipal verifyAgentAssertion(String token) {
        AgentKey[] key = new AgentKey[1];
        Jws.Parsed parsed = Jws.verify(token, AGENT_TYP, header -> {
            key[0] = agentKeys.findById(header.path("kid").asText()).filter(k -> !k.isRevoked()).orElse(null);
            return key[0] == null ? null : Ed25519.publicKeyFromRaw(key[0].getPublicKey());
        });
        JsonNode claims = parsed.payload();
        if (!key[0].getAgentId().toString().equals(claims.path("iss").asText())) {
            throw new ApiException.Unauthorized("Key does not belong to the asserting agent");
        }
        if (!props.issuer().equals(claims.path("aud").asText())) {
            throw new ApiException.Unauthorized("Wrong audience");
        }
        long iat = claims.path("iat").asLong();
        long exp = claims.path("exp").asLong();
        if (exp - iat > props.agentAssertionMaxTtl().toSeconds() || iat > Instant.now().getEpochSecond() + 30) {
            throw new ApiException.Unauthorized("Assertion lifetime too long");
        }
        String jti = claims.path("jti").asText();
        if (jti.isEmpty() || !assertionReplay.firstUse(key[0].getKid() + ":" + jti, exp)) {
            throw new ApiException.Unauthorized("Assertion replayed");
        }
        Agent agent = agents.findById(key[0].getAgentId())
                .orElseThrow(() -> new ApiException.Unauthorized("Unknown agent"));
        if (!agent.isActive()) {
            throw new ApiException.Unauthorized("Agent is suspended");
        }
        return new AgentPrincipal(agent.getId(), agent.getOrgId(), key[0].getKid());
    }
}
