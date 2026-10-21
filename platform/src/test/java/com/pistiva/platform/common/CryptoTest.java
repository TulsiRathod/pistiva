package com.pistiva.platform.common;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pistiva.platform.identity.KeyIds;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class CryptoTest {

    private final ObjectMapper mapper = new ObjectMapper();

    /** Same vector as sdk/packages/agent-sdk/test/crypto.test.ts, so both sides sign identical bytes. */
    @Test
    void jcsMatchesSharedVector() throws Exception {
        String input = "{\"b\":[3,true,null,\"x\"],\"a\":{\"z\":\"\\u0001é\",\"y\":10.0},\"amount\":\"12.50\"}";
        String canonical = new String(Jcs.canonicalize(mapper.readTree(input)), StandardCharsets.UTF_8);
        assertThat(canonical).isEqualTo("{\"a\":{\"y\":10,\"z\":\"\\u0001é\"},\"amount\":\"12.50\",\"b\":[3,true,null,\"x\"]}");
    }

    /** RFC 8032 section 7.1 test 1; the kid matches the SDK's kidFor for the same key. */
    @Test
    void ed25519MatchesRfc8032AndSdkKeyId() {
        String seed = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";
        String publicKey = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
        assertThat(Ed25519.rawPublicKey(Ed25519.publicKeyFromSeed(seed))).isEqualTo(publicKey);
        assertThat(Ed25519.b64url(Ed25519.sign(Ed25519.privateKeyFromSeed(seed), new byte[0])))
                .isEqualTo("5VZDAMNgrHKQhuLMgG6CioSHfx645dl02HPgZSJJAVVfuIIVkKM7rMYeOXAc-bRr0lv18FlbviRlUUFDjnoQCw");
        assertThat(KeyIds.thumbprint(publicKey)).isEqualTo("48rNXC2TEpWmT2w7s_bqWM");
    }

    @Test
    void jcsRejectsFractionalNumbers() {
        assertThatThrownBy(() -> Jcs.canonicalize(mapper.readTree("{\"price\":12.5}")))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void seedRoundTripReproducesKeyPair() {
        KeyPair pair = Ed25519.generate();
        String seed = Ed25519.rawPrivateSeed(pair.getPrivate());
        assertThat(Ed25519.rawPublicKey(Ed25519.publicKeyFromSeed(seed))).isEqualTo(Ed25519.rawPublicKey(pair.getPublic()));
        byte[] sig = Ed25519.sign(Ed25519.privateKeyFromSeed(seed), "hello".getBytes());
        assertThat(Ed25519.verify(Ed25519.publicKeyFromRaw(Ed25519.rawPublicKey(pair.getPublic())), "hello".getBytes(), sig)).isTrue();
        assertThat(Ed25519.verify(pair.getPublic(), "tampered".getBytes(), sig)).isFalse();
    }

    @Test
    void jwsVerifiesAndRejectsTamperingAndExpiry() {
        KeyPair pair = Ed25519.generate();
        long now = Instant.now().getEpochSecond();
        ObjectNode claims = mapper.createObjectNode().put("sub", "a").put("exp", now + 60);
        String token = Jws.sign("test+jwt", "k1", claims, pair.getPrivate());

        assertThat(Jws.verify(token, "test+jwt", h -> pair.getPublic()).payload().get("sub").asText()).isEqualTo("a");
        assertThatThrownBy(() -> Jws.verify(token, "other+jwt", h -> pair.getPublic())).isInstanceOf(ApiException.Unauthorized.class);
        assertThatThrownBy(() -> Jws.verify(token, "test+jwt", h -> Ed25519.generate().getPublic()))
                .isInstanceOf(ApiException.Unauthorized.class);

        String[] parts = token.split("\\.");
        String forged = parts[0] + "." + Ed25519.b64url("{\"sub\":\"b\",\"exp\":9999999999}".getBytes()) + "." + parts[2];
        assertThatThrownBy(() -> Jws.verify(forged, "test+jwt", h -> pair.getPublic())).isInstanceOf(ApiException.Unauthorized.class);

        String expired = Jws.sign("test+jwt", "k1", mapper.createObjectNode().put("exp", now - 1), pair.getPrivate());
        assertThatThrownBy(() -> Jws.verify(expired, "test+jwt", h -> pair.getPublic())).isInstanceOf(ApiException.Unauthorized.class);
    }

    @Test
    void replayCacheAcceptsOnlyFirstUse() {
        ReplayCache cache = new ReplayCache();
        long exp = Instant.now().getEpochSecond() + 60;
        assertThat(cache.firstUse("n1", exp)).isTrue();
        assertThat(cache.firstUse("n1", exp)).isFalse();
        assertThat(cache.firstUse("n2", exp)).isTrue();
    }
}
