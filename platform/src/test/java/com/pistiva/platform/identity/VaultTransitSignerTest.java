package com.pistiva.platform.identity;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pistiva.platform.common.Jws;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The platform key held by Vault Transit: signing, verification and rotation. Skipped without Docker. */
@Testcontainers(disabledWithoutDocker = true)
class VaultTransitSignerTest {

    private static final String TOKEN = "test-root-token";

    @Container
    static GenericContainer<?> vault = new GenericContainer<>("hashicorp/vault:1.18.1")
            .withEnv("VAULT_DEV_ROOT_TOKEN_ID", TOKEN)
            .withExposedPorts(8200)
            .waitingFor(Wait.forHttp("/v1/sys/health").forStatusCode(200));

    static String address;
    static final HttpClient http = HttpClient.newHttpClient();
    static final ObjectMapper mapper = new ObjectMapper();

    @BeforeAll
    static void enableTransit() throws Exception {
        address = "http://" + vault.getHost() + ":" + vault.getMappedPort(8200);
        vaultPost("sys/mounts/transit", "{\"type\":\"transit\"}");
        vaultPost("transit/keys/pistiva-platform", "{\"type\":\"ed25519\"}");
    }

    static void vaultPost(String path, String body) throws Exception {
        HttpResponse<String> res = http.send(HttpRequest.newBuilder(URI.create(address + "/v1/" + path))
                .header("X-Vault-Token", TOKEN).POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(res.statusCode() / 100).as(path + " " + res.body()).isEqualTo(2);
    }

    @Test
    void signsWithTheVaultKeyAndKeepsOldVersionsVerifiableAfterRotation() throws Exception {
        PlatformKeyService keys = new PlatformKeyService(new VaultTransitSigner(address, TOKEN, "transit", "pistiva-platform"));
        ObjectNode claims = mapper.createObjectNode().put("sub", "agent-1").put("exp", Instant.now().getEpochSecond() + 60);
        String before = keys.sign("pistiva-grant+jwt", claims);
        String oldKid = keys.kid();
        assertThat(Jws.verify(before, "pistiva-grant+jwt", h -> keys.publicKey(h.path("kid").asText())).payload().path("sub").asText())
                .isEqualTo("agent-1");

        vaultPost("transit/keys/pistiva-platform/rotate", "{}");
        PlatformKeyService rotated = new PlatformKeyService(new VaultTransitSigner(address, TOKEN, "transit", "pistiva-platform"));
        assertThat(rotated.kid()).isNotEqualTo(oldKid);
        String after = rotated.sign("pistiva-grant+jwt", claims);
        assertThat(mapper.readTree(java.util.Base64.getUrlDecoder().decode(after.split("\\.")[0])).path("kid").asText()).isEqualTo(rotated.kid());
        // Tokens signed before the rotation still verify, and the JWKS lists both versions.
        Jws.verify(before, "pistiva-grant+jwt", h -> rotated.publicKey(h.path("kid").asText()));
        Jws.verify(after, "pistiva-grant+jwt", h -> rotated.publicKey(h.path("kid").asText()));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> jwks = (List<Map<String, Object>>) rotated.jwks().get("keys");
        assertThat(jwks).extracting(k -> k.get("kid")).containsExactlyInAnyOrder(oldKid, rotated.kid());
    }

    @Test
    void refusesAKeyThatIsNotEd25519OrAWrongToken() throws Exception {
        vaultPost("transit/keys/not-ed25519", "{\"type\":\"aes256-gcm96\"}");
        assertThatThrownBy(() -> new VaultTransitSigner(address, TOKEN, "transit", "not-ed25519"))
                .hasMessageContaining("must be of type ed25519");
        assertThatThrownBy(() -> new VaultTransitSigner(address, "wrong-token", "transit", "pistiva-platform"))
                .hasMessageContaining("HTTP 403");
    }
}
