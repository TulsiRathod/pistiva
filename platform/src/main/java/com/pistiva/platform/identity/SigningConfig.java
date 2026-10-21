package com.pistiva.platform.identity;

import com.pistiva.platform.PlatformProperties;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.io.IOException;

/**
 * Chooses where the platform's signing key lives: {@code pistiva.signing.provider} is {@code local}
 * (seed in configuration or a development seed file) or {@code vault-transit} (Vault or OpenBao).
 */
@Configuration
public class SigningConfig {

    @Bean
    PlatformSigner platformSigner(PlatformProperties props,
                                  @Value("${pistiva.signing.provider:local}") String provider,
                                  @Value("${pistiva.signing.vault.address:}") String vaultAddress,
                                  @Value("${pistiva.signing.vault.token:}") String vaultToken,
                                  @Value("${pistiva.signing.vault.mount:transit}") String vaultMount,
                                  @Value("${pistiva.signing.vault.key:pistiva-platform}") String vaultKey) throws IOException {
        return switch (provider) {
            case "local" -> new LocalSeedSigner(props.signingKeySeed(), props.signingKeyFile());
            case "vault-transit" -> new VaultTransitSigner(vaultAddress, vaultToken, vaultMount, vaultKey);
            default -> throw new IllegalStateException("Unknown pistiva.signing.provider " + provider + " (use local or vault-transit)");
        };
    }
}
