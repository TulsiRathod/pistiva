package com.pistiva.platform.identity;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pistiva.platform.PlatformProperties;
import com.pistiva.platform.common.Ed25519;
import com.pistiva.platform.common.Jws;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.util.List;
import java.util.Map;

/**
 * The platform's own Ed25519 signing key, used for task grants and console access tokens.
 * Development loads or creates a seed file; production should supply the seed from KMS/HSM.
 */
@Service
public class PlatformKeyService {

    private static final Logger log = LoggerFactory.getLogger(PlatformKeyService.class);

    private final PrivateKey privateKey;
    private final PublicKey publicKey;
    private final String kid;

    public PlatformKeyService(PlatformProperties props) throws IOException {
        String seed = props.signingKeySeed();
        if (seed == null || seed.isBlank()) {
            seed = loadOrCreateSeed(Path.of(props.signingKeyFile()));
        }
        seed = seed.trim();
        this.privateKey = Ed25519.privateKeyFromSeed(seed);
        this.publicKey = Ed25519.publicKeyFromSeed(seed);
        this.kid = "platform-" + KeyIds.thumbprint(Ed25519.rawPublicKey(publicKey));
    }

    public String kid() {
        return kid;
    }

    public PublicKey publicKey() {
        return publicKey;
    }

    public String sign(String typ, ObjectNode payload) {
        return Jws.sign(typ, kid, payload, privateKey);
    }

    public Map<String, Object> jwks() {
        return Map.of("keys", List.of(Map.of(
                "kty", "OKP",
                "crv", "Ed25519",
                "alg", "EdDSA",
                "use", "sig",
                "kid", kid,
                "x", Ed25519.rawPublicKey(publicKey))));
    }

    private static String loadOrCreateSeed(Path file) throws IOException {
        if (Files.exists(file)) {
            return Files.readString(file, StandardCharsets.US_ASCII);
        }
        log.warn("No signing key configured; generating a development key at {}", file.toAbsolutePath());
        String seed = Ed25519.rawPrivateSeed(Ed25519.generate().getPrivate());
        if (file.getParent() != null) {
            Files.createDirectories(file.getParent());
        }
        Files.writeString(file, seed, StandardCharsets.US_ASCII);
        return seed;
    }
}
