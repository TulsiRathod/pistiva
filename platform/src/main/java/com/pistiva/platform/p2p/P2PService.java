package com.pistiva.platform.p2p;

import com.pistiva.platform.agent.Agent;
import com.pistiva.platform.agent.AgentRepository;
import com.pistiva.platform.common.ApiException;
import com.pistiva.platform.org.Organization;
import com.pistiva.platform.org.OrganizationRepository;
import com.pistiva.platform.security.Principals.AgentPrincipal;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.function.Supplier;
import org.springframework.web.context.request.async.DeferredResult;
import jakarta.annotation.PreDestroy;

/**
 * Signaling and TURN credentials for direct agent-to-agent connections.
 *
 * <p>Offers and answers are opaque to the platform and signed by the agents themselves (over the SDP,
 * the session and both agent ids), so the platform cannot swap in its own DTLS fingerprint. TURN
 * credentials use the shared-secret scheme coturn implements ({@code use-auth-secret}): short-lived,
 * bound to one agent, verifiable by the relay without a database.
 */
@Service
public class P2PService {

    static final int MAX_SDP = 16 * 1024;
    static final int MAX_WAIT_SECONDS = 25;
    static final int MAX_WAITS_PER_AGENT = 3;
    static final int MAX_WAITS_TOTAL = 2000;
    private final java.util.concurrent.ConcurrentHashMap<UUID, Integer> waiting = new java.util.concurrent.ConcurrentHashMap<>();
    private final java.util.concurrent.atomic.AtomicInteger totalWaiting = new java.util.concurrent.atomic.AtomicInteger();
    private final ScheduledExecutorService waiter = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "p2p-long-poll");
        t.setDaemon(true);
        return t;
    });
    static final int MAX_OFFERS_PER_MINUTE = 60;

    private final JdbcTemplate jdbc;
    private final AgentRepository agents;
    private final OrganizationRepository orgs;
    private final List<String> stunUrls;
    private final List<String> turnUrls;
    private final String turnSecret;
    private final Duration credentialTtl;
    private final Duration sessionTtl;

    public P2PService(JdbcTemplate jdbc, AgentRepository agents, OrganizationRepository orgs,
                      @Value("${pistiva.p2p.stun-urls:}") String stunUrls,
                      @Value("${pistiva.p2p.turn-urls:}") String turnUrls,
                      @Value("${pistiva.p2p.turn-secret:}") String turnSecret,
                      @Value("${pistiva.p2p.credential-ttl:10m}") Duration credentialTtl,
                      @Value("${pistiva.p2p.session-ttl:60s}") Duration sessionTtl) {
        this.jdbc = jdbc;
        this.agents = agents;
        this.orgs = orgs;
        this.stunUrls = split(stunUrls);
        this.turnUrls = split(turnUrls);
        this.turnSecret = turnSecret;
        this.credentialTtl = credentialTtl;
        this.sessionTtl = sessionTtl;
    }

    public record IceServers(List<Map<String, Object>> iceServers, long ttlSeconds) {
    }

    public record Session(UUID id, UUID requesterAgentId, UUID providerAgentId, String offer, String offerSignature,
                          String answer, String answerSignature, Instant expiresAt) {
    }

    public IceServers iceServers(AgentPrincipal caller) {
        requireTrusted(caller.agentId());
        List<Map<String, Object>> servers = new ArrayList<>();
        if (!stunUrls.isEmpty()) {
            servers.add(Map.of("urls", stunUrls));
        }
        if (!turnUrls.isEmpty() && turnSecret != null && !turnSecret.isBlank()) {
            long expiry = Instant.now().plus(credentialTtl).getEpochSecond();
            String username = expiry + ":" + caller.agentId();
            Map<String, Object> turn = new LinkedHashMap<>();
            turn.put("urls", turnUrls);
            turn.put("username", username);
            turn.put("credential", turnCredential(turnSecret, username));
            servers.add(turn);
        }
        return new IceServers(servers, credentialTtl.toSeconds());
    }

    /** coturn's use-auth-secret: base64(HMAC-SHA1(secret, username)). */
    static String turnCredential(String secret, String username) {
        try {
            Mac mac = Mac.getInstance("HmacSHA1");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA1"));
            return Base64.getEncoder().encodeToString(mac.doFinal(username.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    public Session offer(AgentPrincipal requester, UUID providerAgentId, String offer, String signature) {
        requireTrusted(requester.agentId());
        if (providerAgentId == null || providerAgentId.equals(requester.agentId())) {
            throw new ApiException.BadRequest("providerAgentId must name another agent");
        }
        requireTrusted(providerAgentId);
        requireSdp(offer, signature);
        Integer recent = jdbc.queryForObject(
                "SELECT count(*) FROM p2p_sessions WHERE requester_agent_id = ? AND created_at > now() - interval '1 minute'",
                Integer.class, requester.agentId());
        if (recent != null && recent >= MAX_OFFERS_PER_MINUTE) {
            throw new ApiException.PolicyDenied("Too many connection attempts");
        }
        UUID id = UUID.randomUUID();
        Instant now = Instant.now();
        Instant expiresAt = now.plus(sessionTtl);
        jdbc.update("""
                INSERT INTO p2p_sessions (id, requester_agent_id, provider_agent_id, offer, offer_signature, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)""",
                id, requester.agentId(), providerAgentId, offer, signature, Timestamp.from(now), Timestamp.from(expiresAt));
        return new Session(id, requester.agentId(), providerAgentId, offer, signature, null, null, expiresAt);
    }

    /** Offers waiting for this agent to answer. */
    public List<Session> pending(AgentPrincipal provider) {
        return jdbc.query("""
                SELECT id, requester_agent_id, provider_agent_id, offer, offer_signature, answer, answer_signature, expires_at
                FROM p2p_sessions WHERE provider_agent_id = ? AND answer IS NULL AND expires_at > now()
                ORDER BY created_at LIMIT 20""",
                (rs, i) -> row(rs), provider.agentId());
    }

    /**
     * Long poll: completes as soon as {@code ready} yields a non-null value, or with {@code onTimeout}
     * after the wait. Waiting parks no request thread; one scheduler re-checks every half second.
     */
    public <T> DeferredResult<T> waitFor(UUID agentId, int waitSeconds, Supplier<T> ready, Supplier<T> onTimeout) {
        int seconds = Math.max(0, Math.min(waitSeconds, MAX_WAIT_SECONDS));
        if (seconds > 0) {
            // A held request is cheap but not free: each one is re-checked against the database twice a second.
            int mine = waiting.merge(agentId, 1, Integer::sum);
            if (mine > MAX_WAITS_PER_AGENT || totalWaiting.incrementAndGet() > MAX_WAITS_TOTAL) {
                release(agentId);
                throw new ApiException.TooManyRequests("Too many open long-poll requests for this agent");
            }
        }
        DeferredResult<T> result = new DeferredResult<>((seconds + 5) * 1000L);
        if (seconds > 0) {
            Runnable done = () -> release(agentId);
            result.onCompletion(done);
            result.onTimeout(() -> result.setResult(onTimeout.get()));
        }
        long deadline = System.nanoTime() + seconds * 1_000_000_000L;
        Runnable[] check = new Runnable[1];
        check[0] = () -> {
            if (result.isSetOrExpired()) {
                return;
            }
            try {
                T value = ready.get();
                if (value != null) {
                    result.setResult(value);
                } else if (System.nanoTime() >= deadline) {
                    result.setResult(onTimeout.get());
                } else {
                    waiter.schedule(check[0], 500, java.util.concurrent.TimeUnit.MILLISECONDS);
                }
            } catch (RuntimeException e) {
                result.setErrorResult(e);
            }
        };
        waiter.execute(check[0]);
        return result;
    }

    private void release(UUID agentId) {
        waiting.computeIfPresent(agentId, (k, v) -> v <= 1 ? null : v - 1);
        totalWaiting.decrementAndGet();
    }

    @PreDestroy
    void shutdown() {
        waiter.shutdownNow();
    }

    public Session answer(AgentPrincipal provider, UUID sessionId, String answer, String signature) {
        requireSdp(answer, signature);
        int updated = jdbc.update("""
                UPDATE p2p_sessions SET answer = ?, answer_signature = ?, answered_at = now()
                WHERE id = ? AND provider_agent_id = ? AND answer IS NULL AND expires_at > now()""",
                answer, signature, sessionId, provider.agentId());
        if (updated == 0) {
            throw new ApiException.NotFound("No open session for this agent");
        }
        return get(provider, sessionId);
    }

    /** Readable by its two agents only; anyone else gets "not found". */
    public Session get(AgentPrincipal caller, UUID sessionId) {
        List<Session> found = jdbc.query("""
                SELECT id, requester_agent_id, provider_agent_id, offer, offer_signature, answer, answer_signature, expires_at
                FROM p2p_sessions WHERE id = ? AND (requester_agent_id = ? OR provider_agent_id = ?)""",
                (rs, i) -> row(rs), sessionId, caller.agentId(), caller.agentId());
        if (found.isEmpty()) {
            throw new ApiException.NotFound("Session not found");
        }
        return found.get(0);
    }

    public int purgeExpired() {
        return jdbc.update("DELETE FROM p2p_sessions WHERE expires_at < now() - interval '10 minutes'");
    }

    private static Session row(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new Session(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getObject(3, UUID.class), rs.getString(4),
                rs.getString(5), rs.getString(6), rs.getString(7), rs.getTimestamp(8).toInstant());
    }

    private void requireTrusted(UUID agentId) {
        Agent agent = agents.findById(agentId).filter(Agent::isActive)
                .orElseThrow(() -> new ApiException.Forbidden("Agent is unknown or suspended"));
        if (orgs.findById(agent.getOrgId()).filter(Organization::isTrusted).isEmpty()) {
            throw new ApiException.Forbidden("Agent's organization is not verified or is suspended");
        }
    }

    private static void requireSdp(String sdp, String signature) {
        if (sdp == null || sdp.isBlank() || sdp.length() > MAX_SDP || signature == null || signature.isBlank() || signature.length() > 200) {
            throw new ApiException.BadRequest("A signed SDP of at most " + MAX_SDP + " characters is required");
        }
    }

    private static List<String> split(String csv) {
        return csv == null || csv.isBlank() ? List.of() : Arrays.stream(csv.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();
    }
}
