package com.pistiva.platform.task;

import com.fasterxml.jackson.databind.JsonNode;
import com.pistiva.platform.agent.Agent;
import com.pistiva.platform.agent.AgentKey;
import com.pistiva.platform.agent.AgentKeyRepository;
import com.pistiva.platform.agent.AgentRepository;
import com.pistiva.platform.audit.AuditService;
import com.pistiva.platform.common.ApiException;
import com.pistiva.platform.common.Ed25519;
import com.pistiva.platform.common.Jcs;
import com.pistiva.platform.observability.PlatformMetrics;
import com.pistiva.platform.security.Principals.AgentPrincipal;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Records a receipt for one message round, signed by the provider and countersigned by the
 * requester. Only hashes and signatures are stored; both parties keep the full receipts and their
 * own detailed logs. A valid receipt proves who signed what, not that the provider's claims are true.
 */
@Service
public class ReceiptService {

    /** A2A task states after which no further rounds may happen. */
    static final Set<String> TERMINAL_STATES = Set.of("completed", "failed", "rejected", "canceled");
    private static final Set<String> STATES = Set.of("completed", "failed", "rejected", "canceled", "input-required");

    private final TaskGrantRepository grants;
    private final TaskReceiptRepository receipts;
    private final AgentRepository agents;
    private final AgentKeyRepository keys;
    private final AuditService audit;
    private final PlatformMetrics metrics;

    public ReceiptService(TaskGrantRepository grants, TaskReceiptRepository receipts, AgentRepository agents,
                          AgentKeyRepository keys, AuditService audit, PlatformMetrics metrics) {
        this.grants = grants;
        this.receipts = receipts;
        this.agents = agents;
        this.keys = keys;
        this.audit = audit;
        this.metrics = metrics;
    }

    public record SignedReceipt(JsonNode receipt, String providerKid, String providerSignature,
                                String requesterKid, String requesterSignature) {
    }

    public record RecordedReceipt(UUID taskId, int round, String status, boolean alreadyRecorded) {
    }

    @Transactional
    public RecordedReceipt record(AgentPrincipal caller, SignedReceipt signed) {
        JsonNode r = signed.receipt();
        UUID taskId = parseUuid(r.path("taskId").asText(), "receipt.taskId");
        UUID grantId = parseUuid(r.path("grantId").asText(), "receipt.grantId");
        metrics.tagTask(taskId);
        TaskGrant grant = grants.findById(grantId).filter(g -> g.getTaskId().equals(taskId))
                .orElseThrow(() -> new ApiException.NotFound("Unknown task or grant"));
        if (!caller.agentId().equals(grant.getRequesterAgentId()) && !caller.agentId().equals(grant.getProviderAgentId())) {
            throw new ApiException.Forbidden("Only a party to the task may submit its receipt");
        }
        if (!grant.getRequesterAgentId().toString().equals(r.path("requesterAgentId").asText())
                || !grant.getProviderAgentId().toString().equals(r.path("providerAgentId").asText())
                || !grant.getCapability().equals(r.path("capability").asText())) {
            throw new ApiException.BadRequest("Receipt does not match the task grant");
        }
        // Milestone-1 receipts carry "status" and no round; they describe a single completed round.
        int round = r.path("round").asInt(1);
        String state = r.has("state") ? r.path("state").asText() : r.path("status").asText();
        if (round < 1 || !STATES.contains(state)) {
            throw new ApiException.BadRequest("receipt.round must be >= 1 and receipt.state a known task state");
        }
        String requestHash = requireText(r, "requestHash");
        String responseHash = requireText(r, "responseHash");

        byte[] canonical;
        try {
            canonical = Jcs.canonicalize(r);
        } catch (IllegalArgumentException e) {
            throw new ApiException.BadRequest(e.getMessage());
        }
        verifySignature(grant.getProviderAgentId(), signed.providerKid(), signed.providerSignature(), canonical, "provider");
        verifySignature(grant.getRequesterAgentId(), signed.requesterKid(), signed.requesterSignature(), canonical, "requester");

        TaskReceipt existing = receipts.findById(new TaskReceipt.Key(taskId, round)).orElse(null);
        if (existing != null) {
            if (!existing.getRequestHash().equals(requestHash) || !existing.getResponseHash().equals(responseHash)) {
                throw new ApiException.Conflict("A different receipt is already recorded for round " + round);
            }
            return new RecordedReceipt(taskId, round, state, true);
        }
        if (receipts.findByTaskIdOrderByRoundAsc(taskId).stream().anyMatch(x -> TERMINAL_STATES.contains(x.getState()))) {
            throw new ApiException.Conflict("Task already reached a terminal state");
        }
        receipts.save(new TaskReceipt(taskId, round, grantId, state, requestHash, responseHash,
                signed.providerKid(), signed.providerSignature(), signed.requesterKid(), signed.requesterSignature()));
        boolean terminal = TERMINAL_STATES.contains(state);
        Duration sinceFirstGrant = Duration.ZERO;
        if (terminal) {
            List<TaskGrant> taskGrants = grants.findByTaskId(taskId);
            taskGrants.forEach(TaskGrant::complete);
            Instant first = taskGrants.stream().map(TaskGrant::getCreatedAt).min(Comparator.naturalOrder()).orElse(Instant.now());
            sinceFirstGrant = Duration.between(first, Instant.now());
        }
        metrics.round(grant.getCapability(), state, terminal, sinceFirstGrant);

        Agent requester = agents.findById(grant.getRequesterAgentId()).orElseThrow();
        Agent provider = agents.findById(grant.getProviderAgentId()).orElseThrow();
        audit.record(taskId, "RECEIPT_RECORDED", "agent:" + caller.agentId(), requester.getOrgId(), provider.getOrgId(),
                requestHash, responseHash, Map.of(
                        "round", round, "status", state,
                        "providerKid", signed.providerKid(), "providerSignature", signed.providerSignature(),
                        "requesterKid", signed.requesterKid(), "requesterSignature", signed.requesterSignature()));
        return new RecordedReceipt(taskId, round, state, false);
    }

    private void verifySignature(UUID agentId, String kid, String signature, byte[] data, String party) {
        AgentKey key = keys.findById(kid == null ? "" : kid)
                .filter(k -> k.getAgentId().equals(agentId) && !k.isRevoked())
                .orElseThrow(() -> new ApiException.BadRequest(party + " key is unknown, revoked or not theirs"));
        byte[] sig;
        try {
            sig = Ed25519.b64urlDecode(signature == null ? "" : signature);
        } catch (IllegalArgumentException e) {
            throw new ApiException.BadRequest(party + " signature must be base64url");
        }
        if (!Ed25519.verify(Ed25519.publicKeyFromRaw(key.getPublicKey()), data, sig)) {
            throw new ApiException.BadRequest(party + " signature does not verify");
        }
    }

    private static String requireText(JsonNode node, String field) {
        String value = node.path(field).asText("");
        if (value.isBlank()) {
            throw new ApiException.BadRequest("receipt." + field + " is required");
        }
        return value;
    }

    private static UUID parseUuid(String value, String field) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw new ApiException.BadRequest(field + " must be a UUID");
        }
    }
}
