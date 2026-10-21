package com.pistiva.platform;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pistiva.platform.common.Ed25519;
import com.pistiva.platform.common.Jcs;
import com.pistiva.platform.common.Jws;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.security.KeyPair;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * End-to-end control-plane checks against a real Postgres, mapped to the MVP acceptance criteria.
 * Skipped automatically when Docker is not available.
 */
@SpringBootTest(properties = {
        "pistiva.signing-key-file=target/test-signing-key",
        "pistiva.webhooks.allow-http=true",
        "pistiva.webhooks.dispatch-interval=1h",
        "pistiva.tasks.sweep-interval=1h"})
@AutoConfigureMockMvc
@Testcontainers(disabledWithoutDocker = true)
class PlatformFlowTest {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine");

    private static final AtomicInteger SEQ = new AtomicInteger();

    @Autowired
    MockMvc mvc;
    @Autowired
    ObjectMapper mapper;
    @Autowired
    PlatformProperties props;
    @Autowired
    com.pistiva.platform.webhook.WebhookDispatcher dispatcher;
    @Autowired
    com.pistiva.platform.task.TaskSweeper sweeper;
    @Autowired
    org.springframework.jdbc.core.JdbcTemplate jdbc;

    String adminToken;

    record TestAgent(UUID orgId, String userToken, UUID agentId, String kid, KeyPair keys) {
    }

    @BeforeEach
    void login() throws Exception {
        adminToken = body(mvc.perform(post("/auth/login").contentType(MediaType.APPLICATION_JSON)
                .content(json(mapper.createObjectNode().put("email", props.adminEmail()).put("password", props.adminPassword())))))
                .get("accessToken").asText();
    }

    @Test
    void discoveryReturnsOnlyVerifiedOrganizations() throws Exception {
        TestAgent supplier = newAgent(true, "quote.request");
        TestAgent unverified = newAgent(false, "quote.request");

        JsonNode found = body(mvc.perform(get("/discovery").param("capability", "quote.request")
                .header("Authorization", "Bearer " + supplier.userToken())).andExpect(status().isOk()));
        assertThat(found.findValuesAsText("agentId")).contains(supplier.agentId().toString())
                .doesNotContain(unverified.agentId().toString());
    }

    @Test
    void cardWithBadSignatureIsRejected() throws Exception {
        TestAgent agent = newAgent(true, null);
        ObjectNode card = card(agent, "quote.request");
        String wrongSig = Ed25519.b64url(Ed25519.sign(Ed25519.generate().getPrivate(), Jcs.canonicalize(card)));
        mvc.perform(put("/agents/" + agent.agentId() + "/card").header("Authorization", "Bearer " + agent.userToken())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json(mapper.createObjectNode().<ObjectNode>set("card", card).put("kid", agent.kid()).put("signature", wrongSig))))
                .andExpect(status().isBadRequest());
    }

    @Test
    void outOfScopeAndOverBudgetRequestsAreDeniedAndAudited() throws Exception {
        TestAgent supplier = newAgent(true, "quote.request");
        TestAgent buyer = newAgent(true, null);

        requestGrant(buyer, supplier, "inventory.export", "100.00").andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error").value("policy_denied"));
        requestGrant(buyer, supplier, "quote.request", "999999.00").andExpect(status().isForbidden());

        JsonNode events = body(mvc.perform(get("/audit").param("orgId", buyer.orgId().toString())
                .header("Authorization", "Bearer " + buyer.userToken())));
        assertThat(events.findValuesAsText("type").stream().filter("GRANT_DENIED"::equals)).hasSize(2);
    }

    @Test
    void grantAboveApprovalThresholdRequiresApproval() throws Exception {
        TestAgent supplier = newAgent(true, "quote.request");
        TestAgent buyer = newAgent(true, null);

        assertThat(body(requestGrant(buyer, supplier, "quote.request", "500.00").andExpect(status().isOk()))
                .get("approvalRequired").asBoolean()).isFalse();
        assertThat(body(requestGrant(buyer, supplier, "quote.request", "20000.00").andExpect(status().isOk()))
                .get("approvalRequired").asBoolean()).isTrue();
    }

    @Test
    void suspendedAgentAndRevokedKeyCannotStartTasks() throws Exception {
        TestAgent supplier = newAgent(true, "quote.request");
        TestAgent buyer = newAgent(true, null);
        requestGrant(buyer, supplier, "quote.request", "10.00").andExpect(status().isOk());

        mvc.perform(post("/agents/" + buyer.agentId() + "/status").header("Authorization", "Bearer " + buyer.userToken())
                .contentType(MediaType.APPLICATION_JSON).content("{\"status\":\"SUSPENDED\"}")).andExpect(status().isOk());
        requestGrant(buyer, supplier, "quote.request", "10.00").andExpect(status().isUnauthorized());

        mvc.perform(post("/agents/" + buyer.agentId() + "/status").header("Authorization", "Bearer " + buyer.userToken())
                .contentType(MediaType.APPLICATION_JSON).content("{\"status\":\"ACTIVE\"}")).andExpect(status().isOk());
        mvc.perform(delete("/agents/" + buyer.agentId() + "/keys/" + buyer.kid())
                .header("Authorization", "Bearer " + buyer.userToken())).andExpect(status().isOk());
        requestGrant(buyer, supplier, "quote.request", "10.00").andExpect(status().isUnauthorized());
    }

    @Test
    void replayedAgentAssertionIsRejected() throws Exception {
        TestAgent supplier = newAgent(true, "quote.request");
        TestAgent buyer = newAgent(true, null);
        String assertion = assertion(buyer);
        grantWith(assertion, supplier, "quote.request", "10.00").andExpect(status().isOk());
        grantWith(assertion, supplier, "quote.request", "10.00").andExpect(status().isUnauthorized());
    }

    @Test
    void receiptNeedsBothValidSignatures() throws Exception {
        TestAgent supplier = newAgent(true, "quote.request");
        TestAgent buyer = newAgent(true, null);
        JsonNode grant = body(requestGrant(buyer, supplier, "quote.request", "10.00"));

        ObjectNode receipt = mapper.createObjectNode()
                .put("taskId", grant.get("taskId").asText())
                .put("grantId", grant.get("jti").asText())
                .put("requesterAgentId", buyer.agentId().toString())
                .put("providerAgentId", supplier.agentId().toString())
                .put("capability", "quote.request")
                .put("requestHash", "sha256-req")
                .put("responseHash", "sha256-res")
                .put("status", "completed")
                .put("issuedAt", Instant.now().getEpochSecond());
        byte[] canonical = Jcs.canonicalize(receipt);
        String providerSig = Ed25519.b64url(Ed25519.sign(supplier.keys().getPrivate(), canonical));
        String requesterSig = Ed25519.b64url(Ed25519.sign(buyer.keys().getPrivate(), canonical));

        ObjectNode tampered = receipt.deepCopy().put("responseHash", "sha256-other");
        submitReceipt(buyer, tampered, supplier.kid(), providerSig, buyer.kid(), requesterSig).andExpect(status().isBadRequest());
        submitReceipt(buyer, receipt, supplier.kid(), providerSig, buyer.kid(), requesterSig).andExpect(status().isOk())
                .andExpect(jsonPath("$.alreadyRecorded").value(false));
        submitReceipt(supplier, receipt, supplier.kid(), providerSig, buyer.kid(), requesterSig).andExpect(status().isOk())
                .andExpect(jsonPath("$.alreadyRecorded").value(true));
    }

    @Test
    void procurementPackIsRegisteredWithSelfContainedSchemas() throws Exception {
        JsonNode types = body(mvc.perform(get("/task-types")).andExpect(status().isOk()));
        assertThat(types.findValuesAsText("name")).contains("quote.request", "order.draft", "order.confirm", "delivery.update");

        JsonNode quote = body(mvc.perform(get("/task-types/quote.request/versions/1")).andExpect(status().isOk()));
        assertThat(quote.get("direction").asText()).isEqualTo("requester_to_provider");
        JsonNode request = quote.get("messages").get("request");
        assertThat(request.get("$schema").asText()).contains("2020-12");
        assertThat(request.get("$defs").has("sku")).isTrue();
        assertThat(quote.get("messages").has("clarification")).isTrue();
    }

    @Test
    void publishedTaskTypeVersionsAreImmutable() throws Exception {
        String pack = """
                {"pack":"procurement","taskTypes":[{"name":"quote.request","version":1,"description":"changed",
                 "direction":"requester_to_provider","cardinality":"one_to_one","handler":"quote.request",
                 "messages":{"request":{"type":"object"},"result":{"type":"object"}}}]}""";
        mvc.perform(post("/task-types/packs").header("Authorization", "Bearer " + adminToken)
                .contentType(MediaType.APPLICATION_JSON).content(pack)).andExpect(status().isConflict());
    }

    @Test
    void cardAdvertisingUnregisteredTaskTypeIsRejected() throws Exception {
        TestAgent agent = newAgent(true, null);
        ObjectNode card = card(agent, "quote.request");
        ((ObjectNode) card.get("capabilities").get(0)).put("version", 99);
        String sig = Ed25519.b64url(Ed25519.sign(agent.keys().getPrivate(), Jcs.canonicalize(card)));
        mvc.perform(put("/agents/" + agent.agentId() + "/card").header("Authorization", "Bearer " + agent.userToken())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json(mapper.createObjectNode().<ObjectNode>set("card", card).put("kid", agent.kid()).put("signature", sig))))
                .andExpect(status().isBadRequest());
    }

    @Test
    void grantPinsTaskTypeVersionAndTaskCanBeContinuedWithoutRaisingBudget() throws Exception {
        TestAgent supplier = newAgent(true, "quote.request");
        TestAgent buyer = newAgent(true, null);
        JsonNode first = body(requestGrant(buyer, supplier, "quote.request", "100.00").andExpect(status().isOk()));
        String[] parts = first.get("grant").asText().split("\\.");
        JsonNode claims = mapper.readTree(Ed25519.b64urlDecode(parts[1]));
        assertThat(claims.get("ttv").asInt()).isEqualTo(1);

        String taskId = first.get("taskId").asText();
        JsonNode next = body(continueGrant(buyer, supplier, taskId, "100.00").andExpect(status().isOk()));
        assertThat(next.get("taskId").asText()).isEqualTo(taskId);
        assertThat(next.get("jti").asText()).isNotEqualTo(first.get("jti").asText());
        continueGrant(buyer, supplier, taskId, "500.00").andExpect(status().isForbidden());
        continueGrant(supplier, buyer, taskId, "100.00").andExpect(status().isForbidden());
    }

    @Test
    void receiptsAreRecordedPerRoundUntilTerminal() throws Exception {
        TestAgent supplier = newAgent(true, "quote.request");
        TestAgent buyer = newAgent(true, null);
        JsonNode grant = body(requestGrant(buyer, supplier, "quote.request", "10.00"));

        submitRound(buyer, supplier, grant, 1, "input-required").andExpect(status().isOk());
        submitRound(buyer, supplier, grant, 2, "completed").andExpect(status().isOk());
        submitRound(buyer, supplier, grant, 3, "completed").andExpect(status().isConflict());
        continueGrant(buyer, supplier, grant.get("taskId").asText(), "10.00").andExpect(status().isForbidden());
    }

    @Test
    void adminDashboardIsAdminOnlyAndCountsNetworkActivity() throws Exception {
        TestAgent supplier = newAgent(true, "quote.request");
        TestAgent buyer = newAgent(true, null);
        requestGrant(buyer, supplier, "quote.request", "10.00").andExpect(status().isOk());
        requestGrant(buyer, supplier, "inventory.export", "10.00").andExpect(status().isForbidden());

        mvc.perform(get("/admin/overview").header("Authorization", "Bearer " + buyer.userToken())).andExpect(status().isForbidden());

        JsonNode overview = body(mvc.perform(get("/admin/overview").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk()));
        assertThat(overview.get("organizations").get("verified").asLong()).isGreaterThanOrEqualTo(2);
        assertThat(overview.get("activity")).hasSize(14);
        JsonNode today = overview.get("activity").get(13);
        assertThat(today.get("grantsIssued").asLong()).isGreaterThanOrEqualTo(1);
        assertThat(today.get("grantsDenied").asLong()).isGreaterThanOrEqualTo(1);

        JsonNode orgs = body(mvc.perform(get("/admin/organizations").header("Authorization", "Bearer " + adminToken)));
        JsonNode supplierRow = null;
        for (JsonNode o : orgs) {
            if (o.get("id").asText().equals(supplier.orgId().toString())) {
                supplierRow = o;
            }
        }
        assertThat(supplierRow).isNotNull();
        assertThat(supplierRow.get("agents").asLong()).isEqualTo(1);
        assertThat(supplierRow.get("lastActivity").isNull()).isFalse();

        JsonNode events = body(mvc.perform(get("/admin/events").param("limit", "5").header("Authorization", "Bearer " + adminToken)));
        assertThat(events).hasSizeLessThanOrEqualTo(5);
        assertThat(events.get(0).get("type").asText()).isNotBlank();
    }

    @Test
    void commitmentAboveThresholdNeedsAMatchingSingleUseHumanApproval() throws Exception {
        TestAgent supplier = newAgent(true, "order.confirm");
        TestAgent buyer = newAgent(true, null);
        JsonNode policy = body(mvc.perform(get("/orgs/" + buyer.orgId() + "/policy").header("Authorization", "Bearer " + buyer.userToken())));
        ((ObjectNode) policy).putArray("allowedCapabilities").add("quote.request").add("order.draft").add("order.confirm");
        mvc.perform(put("/orgs/" + buyer.orgId() + "/policy").header("Authorization", "Bearer " + buyer.userToken())
                .contentType(MediaType.APPLICATION_JSON).content(json(policy))).andExpect(status().isOk());

        requestGrant(buyer, supplier, "order.confirm", "20000.00").andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error").value("approval_required"));
        requestGrant(buyer, supplier, "order.confirm", "500.00").andExpect(status().isOk());

        JsonNode approval = body(mvc.perform(post("/approvals").header("Authorization", "Bearer " + assertion(buyer))
                .contentType(MediaType.APPLICATION_JSON)
                .content(json(mapper.createObjectNode().put("providerAgentId", supplier.agentId().toString())
                        .put("capability", "order.confirm").put("reference", "DRAFT-1234").put("amount", "20000.00")
                        .put("currency", "INR")))).andExpect(status().isOk()));
        String approvalId = approval.get("id").asText();
        assertThat(approval.get("status").asText()).isEqualTo("PENDING");
        grantWithApproval(buyer, supplier, "20000.00", approvalId).andExpect(status().isForbidden());

        // A developer of the same organization may not approve.
        String devToken = body(mvc.perform(post("/auth/register").contentType(MediaType.APPLICATION_JSON)
                .content(json(mapper.createObjectNode().put("email", "dev-" + UUID.randomUUID() + "@example.com")
                        .put("password", "correct-horse-battery").put("orgName", "Dev Org")
                        .put("domain", "dev" + UUID.randomUUID().toString().substring(0, 8) + ".example.com"))))).get("accessToken").asText();
        String devEmail = body(mvc.perform(get("/me").header("Authorization", "Bearer " + devToken))).get("email").asText();
        mvc.perform(post("/orgs/" + buyer.orgId() + "/members").header("Authorization", "Bearer " + buyer.userToken())
                .contentType(MediaType.APPLICATION_JSON).content(json(mapper.createObjectNode().put("email", devEmail).put("role", "DEVELOPER"))))
                .andExpect(status().isOk());
        decide(devToken, approvalId, "APPROVED", null).andExpect(status().isForbidden());

        decide(buyer.userToken(), approvalId, "REJECTED", null).andExpect(status().isBadRequest());
        decide(buyer.userToken(), approvalId, "APPROVED", "Within the quarterly budget").andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("APPROVED"));
        decide(buyer.userToken(), approvalId, "REJECTED", "changed my mind").andExpect(status().isConflict());

        grantWithApproval(buyer, supplier, "25000.00", approvalId).andExpect(status().isForbidden());
        JsonNode grant = body(grantWithApproval(buyer, supplier, "20000.00", approvalId).andExpect(status().isOk()));
        JsonNode claims = mapper.readTree(Ed25519.b64urlDecode(grant.get("grant").asText().split("\\.")[1]));
        assertThat(claims.get("apv").asText()).isEqualTo(approvalId);
        grantWithApproval(buyer, supplier, "20000.00", approvalId).andExpect(status().isForbidden())
                .andExpect(jsonPath("$.message").value("Approval has already been used"));

        JsonNode listed = body(mvc.perform(get("/approvals").param("orgId", buyer.orgId().toString())
                .header("Authorization", "Bearer " + buyer.userToken())));
        assertThat(listed.get(0).get("used").asBoolean()).isTrue();
        JsonNode events = body(mvc.perform(get("/audit").param("orgId", buyer.orgId().toString())
                .header("Authorization", "Bearer " + buyer.userToken())));
        assertThat(events.findValuesAsText("type")).contains("APPROVAL_REQUESTED", "APPROVAL_DECIDED");
    }

    @Test
    void webhooksDeliverSignedEventsFromTheOutboxAndRetryFailures() throws Exception {
        TestAgent supplier = newAgent(true, "quote.request");
        TestAgent buyer = newAgent(true, null);
        java.util.List<String[]> received = new java.util.concurrent.CopyOnWriteArrayList<>();
        java.util.concurrent.atomic.AtomicInteger failuresLeft = new java.util.concurrent.atomic.AtomicInteger(1);
        com.sun.net.httpserver.HttpServer server = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/hook", ex -> {
            String body = new String(ex.getRequestBody().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            received.add(new String[]{ex.getRequestHeaders().getFirst("X-Pistiva-Signature"), ex.getRequestHeaders().getFirst("X-Pistiva-Timestamp"), body,
                    ex.getRequestHeaders().getFirst("X-Pistiva-Event")});
            int code = failuresLeft.getAndDecrement() > 0 ? 500 : 204;
            ex.sendResponseHeaders(code, -1);
            ex.close();
        });
        server.start();
        try {
            String url = "http://127.0.0.1:" + server.getAddress().getPort() + "/hook";
            JsonNode hook = body(mvc.perform(post("/orgs/" + buyer.orgId() + "/webhooks").header("Authorization", "Bearer " + buyer.userToken())
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(json(mapper.createObjectNode().put("url", url).<ObjectNode>set("events", mapper.createArrayNode().add("GRANT_DENIED")))))
                    .andExpect(status().isOk()));
            String secret = hook.get("secret").asText();
            assertThat(secret).startsWith("whsec_");
            JsonNode listed = body(mvc.perform(get("/orgs/" + buyer.orgId() + "/webhooks").header("Authorization", "Bearer " + buyer.userToken())));
            assertThat(listed.get(0).get("secret").isNull()).isTrue();

            requestGrant(buyer, supplier, "inventory.export", "1.00").andExpect(status().isForbidden()); // GRANT_DENIED
            requestGrant(buyer, supplier, "quote.request", "1.00").andExpect(status().isOk());           // not subscribed

            assertThat(dispatcher.dispatchDue()).isEqualTo(1);
            assertThat(received).hasSize(1);                                 // first attempt got a 500
            assertThat(dispatcher.dispatchDue()).isZero();                   // backing off
            jdbc.update("UPDATE outbox_events SET next_attempt_at = now() WHERE delivered_at IS NULL");
            assertThat(dispatcher.dispatchDue()).isEqualTo(1);
            assertThat(received).hasSize(2);

            String[] last = received.get(1);
            javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
            mac.init(new javax.crypto.spec.SecretKeySpec(secret.getBytes(java.nio.charset.StandardCharsets.UTF_8), "HmacSHA256"));
            String expected = "sha256=" + java.util.HexFormat.of().formatHex(mac.doFinal((last[1] + "." + last[2]).getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            assertThat(last[0]).isEqualTo(expected);
            assertThat(last[3]).isEqualTo("GRANT_DENIED");
            assertThat(mapper.readTree(last[2]).get("details").get("reason").asText()).contains("inventory.export");

            JsonNode deliveries = body(mvc.perform(get("/orgs/" + buyer.orgId() + "/webhooks/" + hook.get("id").asText() + "/deliveries")
                    .header("Authorization", "Bearer " + buyer.userToken())));
            assertThat(deliveries.get(0).get("attempts").asInt()).isEqualTo(2);
            assertThat(deliveries.get(0).get("deliveredAt").isNull()).isFalse();
        } finally {
            server.stop(0);
        }
    }

    @Test
    void sweeperExpiresAbandonedTasksButNotFinishedOnes() throws Exception {
        TestAgent supplier = newAgent(true, "quote.request");
        TestAgent buyer = newAgent(true, null);
        String abandoned = body(requestGrant(buyer, supplier, "quote.request", "1.00")).get("taskId").asText();
        JsonNode finished = body(requestGrant(buyer, supplier, "quote.request", "1.00"));
        submitRound(buyer, supplier, finished, 1, "completed").andExpect(status().isOk());
        jdbc.update("UPDATE task_grants SET expires_at = now() - interval '2 days' WHERE task_id IN (?, ?)",
                UUID.fromString(abandoned), UUID.fromString(finished.get("taskId").asText()));

        assertThat(sweeper.sweep()).isGreaterThanOrEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT status FROM task_grants WHERE task_id = ?", String.class, UUID.fromString(abandoned))).isEqualTo("EXPIRED");
        assertThat(jdbc.queryForObject("SELECT status FROM task_grants WHERE task_id = ?", String.class, UUID.fromString(finished.get("taskId").asText()))).isEqualTo("COMPLETED");
        JsonNode events = body(mvc.perform(get("/audit").param("orgId", buyer.orgId().toString()).param("taskId", abandoned)
                .header("Authorization", "Bearer " + buyer.userToken())));
        assertThat(events.findValuesAsText("type")).contains("TASK_EXPIRED");
        assertThat(sweeper.sweep()).isZero(); // idempotent
    }

    // --- helpers ---

    private ResultActions grantWithApproval(TestAgent requester, TestAgent provider, String budget, String approvalId) throws Exception {
        return mvc.perform(post("/grants").header("Authorization", "Bearer " + assertion(requester))
                .contentType(MediaType.APPLICATION_JSON)
                .content(json(mapper.createObjectNode().put("providerAgentId", provider.agentId().toString())
                        .put("capability", "order.confirm").put("budget", budget).put("currency", "INR")
                        .put("approvalId", approvalId))));
    }

    private ResultActions decide(String userToken, String approvalId, String decision, String comment) throws Exception {
        ObjectNode body = mapper.createObjectNode().put("decision", decision);
        if (comment != null) {
            body.put("comment", comment);
        }
        return mvc.perform(post("/approvals/" + approvalId + "/decision").header("Authorization", "Bearer " + userToken)
                .contentType(MediaType.APPLICATION_JSON).content(json(body)));
    }

    private ResultActions continueGrant(TestAgent requester, TestAgent provider, String taskId, String budget) throws Exception {
        return mvc.perform(post("/grants").header("Authorization", "Bearer " + assertion(requester))
                .contentType(MediaType.APPLICATION_JSON)
                .content(json(mapper.createObjectNode().put("providerAgentId", provider.agentId().toString())
                        .put("capability", "quote.request").put("budget", budget).put("currency", "INR")
                        .put("continueTaskId", taskId))));
    }

    private ResultActions submitRound(TestAgent buyer, TestAgent supplier, JsonNode grant, int round, String state) throws Exception {
        ObjectNode receipt = mapper.createObjectNode()
                .put("taskId", grant.get("taskId").asText())
                .put("grantId", grant.get("jti").asText())
                .put("round", round)
                .put("state", state)
                .put("requesterAgentId", buyer.agentId().toString())
                .put("providerAgentId", supplier.agentId().toString())
                .put("capability", "quote.request")
                .put("taskTypeVersion", 1)
                .put("requestHash", "sha256-req" + round)
                .put("responseHash", "sha256-res" + round)
                .put("issuedAt", Instant.now().getEpochSecond());
        byte[] canonical = Jcs.canonicalize(receipt);
        return submitReceipt(buyer, receipt, supplier.kid(), Ed25519.b64url(Ed25519.sign(supplier.keys().getPrivate(), canonical)),
                buyer.kid(), Ed25519.b64url(Ed25519.sign(buyer.keys().getPrivate(), canonical)));
    }

    private TestAgent newAgent(boolean verified, String capability) throws Exception {
        int n = SEQ.incrementAndGet();
        String suffix = n + "-" + UUID.randomUUID().toString().substring(0, 8);
        String token = body(mvc.perform(post("/auth/register").contentType(MediaType.APPLICATION_JSON)
                .content(json(mapper.createObjectNode().put("email", "owner" + suffix + "@example.com")
                        .put("password", "correct-horse-battery").put("orgName", "Org " + suffix)
                        .put("domain", "org" + suffix + ".example.com"))))
                .andExpect(status().isOk())).get("accessToken").asText();
        UUID orgId = UUID.fromString(body(mvc.perform(get("/me").header("Authorization", "Bearer " + token)))
                .get("organizations").get(0).get("orgId").asText());
        if (verified) {
            mvc.perform(post("/orgs/" + orgId + "/verify").header("Authorization", "Bearer " + adminToken)
                    .contentType(MediaType.APPLICATION_JSON).content("{\"method\":\"manual\"}")).andExpect(status().isOk());
        }
        UUID agentId = UUID.fromString(body(mvc.perform(post("/agents").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON)
                .content(json(mapper.createObjectNode().put("orgId", orgId.toString()).put("name", "agent-" + n)
                        .put("version", "1.0.0").put("endpointUrl", "http://localhost:9" + n))))
                .andExpect(status().isOk())).get("id").asText());
        KeyPair keys = Ed25519.generate();
        String kid = body(mvc.perform(post("/agents/" + agentId + "/keys").header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON)
                .content(json(mapper.createObjectNode().put("publicKey", Ed25519.rawPublicKey(keys.getPublic())))))
                .andExpect(status().isOk())).get("kid").asText();
        TestAgent agent = new TestAgent(orgId, token, agentId, kid, keys);
        if (capability != null) {
            ObjectNode card = card(agent, capability);
            String sig = Ed25519.b64url(Ed25519.sign(keys.getPrivate(), Jcs.canonicalize(card)));
            mvc.perform(put("/agents/" + agentId + "/card").header("Authorization", "Bearer " + token)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(json(mapper.createObjectNode().<ObjectNode>set("card", card).put("kid", kid).put("signature", sig))))
                    .andExpect(status().isOk());
        }
        return agent;
    }

    private ObjectNode card(TestAgent agent, String capability) {
        ObjectNode card = mapper.createObjectNode()
                .put("agentId", agent.agentId().toString())
                .put("orgId", agent.orgId().toString())
                .put("kid", agent.kid())
                .put("name", "Supplier agent")
                .put("version", "1.0.0")
                .put("endpoint", "http://localhost:9100")
                .put("issuedAt", Instant.now().getEpochSecond());
        ObjectNode cap = card.putArray("capabilities").addObject().put("name", capability).put("version", 1);
        cap.putObject("price").put("model", "per_task").put("amount", "10.00").put("currency", "INR");
        cap.putArray("responseFields").add("available").add("unitPrice").add("validUntil").add("terms");
        return card;
    }

    private String assertion(TestAgent agent) {
        long now = Instant.now().getEpochSecond();
        ObjectNode claims = mapper.createObjectNode().put("iss", agent.agentId().toString()).put("aud", props.issuer())
                .put("iat", now).put("exp", now + 60).put("jti", UUID.randomUUID().toString());
        return Jws.sign("pistiva-agent+jwt", agent.kid(), claims, agent.keys().getPrivate());
    }

    private ResultActions requestGrant(TestAgent requester, TestAgent provider, String capability, String budget) throws Exception {
        return grantWith(assertion(requester), provider, capability, budget);
    }

    private ResultActions grantWith(String assertion, TestAgent provider, String capability, String budget) throws Exception {
        return mvc.perform(post("/grants").header("Authorization", "Bearer " + assertion)
                .contentType(MediaType.APPLICATION_JSON)
                .content(json(mapper.createObjectNode().put("providerAgentId", provider.agentId().toString())
                        .put("capability", capability).put("budget", budget).put("currency", "INR"))));
    }

    private ResultActions submitReceipt(TestAgent submitter, ObjectNode receipt, String providerKid, String providerSig,
                                        String requesterKid, String requesterSig) throws Exception {
        return mvc.perform(post("/audit/receipts").header("Authorization", "Bearer " + assertion(submitter))
                .contentType(MediaType.APPLICATION_JSON)
                .content(json(mapper.createObjectNode().<ObjectNode>set("receipt", receipt)
                        .put("providerKid", providerKid).put("providerSignature", providerSig)
                        .put("requesterKid", requesterKid).put("requesterSignature", requesterSig))));
    }

    private JsonNode body(ResultActions result) throws Exception {
        return mapper.readTree(result.andReturn().getResponse().getContentAsString());
    }

    private String json(JsonNode node) throws Exception {
        return mapper.writeValueAsString(node);
    }
}
