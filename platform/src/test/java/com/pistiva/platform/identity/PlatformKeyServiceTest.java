package com.pistiva.platform.identity;

import com.pistiva.platform.common.Ed25519;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class PlatformKeyServiceTest {

    @Test
    void keepsAProperSeedAndDerivesOneFromAnyOtherSecret() {
        String seed = Ed25519.rawPrivateSeed(Ed25519.generate().getPrivate());
        assertThat(PlatformKeyService.normalizeSeed(seed)).isEqualTo(seed);

        // A provider-generated secret (standard base64 with padding) becomes a stable 32-byte seed.
        String secret = "q8Jx+7Zp3W1mR9tL0vB2nY6cK4hF5sD8aE3gU1oI7wQ=";
        String derived = PlatformKeyService.normalizeSeed(secret);
        assertThat(Ed25519.b64urlDecode(derived)).hasSize(32);
        assertThat(PlatformKeyService.normalizeSeed(secret)).isEqualTo(derived);

        assertThatThrownBy(() -> PlatformKeyService.normalizeSeed("too-short")).isInstanceOf(IllegalStateException.class);
    }
}
