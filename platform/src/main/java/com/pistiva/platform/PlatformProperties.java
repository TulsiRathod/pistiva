package com.pistiva.platform;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;

/**
 * @param signingKeySeed   base64url Ed25519 seed for grants and user tokens; when blank a key is
 *                         generated at {@code signingKeyFile} (dev only — use KMS/HSM in production)
 * @param grantTtl         lifetime of a task grant
 * @param userTokenTtl     lifetime of a console access token
 * @param adminEmail       bootstrap platform-admin account (created at startup if missing)
 * @param corsOrigins      comma-separated origins allowed to call the API from a browser
 */
@ConfigurationProperties(prefix = "pistiva")
public record PlatformProperties(
        String issuer,
        String signingKeySeed,
        String signingKeyFile,
        Duration grantTtl,
        Duration userTokenTtl,
        Duration agentAssertionMaxTtl,
        String adminEmail,
        String adminPassword,
        String corsOrigins) {
}
