package com.pistiva.platform.identity;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pistiva.platform.common.Ed25519;
import com.pistiva.platform.common.Jws;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.security.PublicKey;
import java.util.List;
import java.util.Map;

/**
 * The platform's Ed25519 signing identity, used for task grants and console access tokens. The key
 * itself is held by a {@link PlatformSigner}: in memory for development, or in a KMS/HSM.
 */
@Service
public class PlatformKeyService {

    private static final Logger log = LoggerFactory.getLogger(PlatformKeyService.class);

    private final PlatformSigner signer;

    public PlatformKeyService(PlatformSigner signer) {
        this.signer = signer;
        log.info("Platform signing key {} ({})", signer.currentKid(), signer.describe());
    }

    public String kid() {
        return signer.currentKid();
    }

    /** The verification key for a kid this platform issued, or null for an unknown one. */
    public PublicKey publicKey(String kid) {
        return kid == null ? null : signer.verificationKeys().get(kid);
    }

    public String sign(String typ, ObjectNode payload) {
        return Jws.sign(typ, signer.currentKid(), payload, signer::sign);
    }

    public Map<String, Object> jwks() {
        List<Map<String, Object>> keys = signer.verificationKeys().entrySet().stream()
                .map(e -> Map.<String, Object>of(
                        "kty", "OKP",
                        "crv", "Ed25519",
                        "alg", "EdDSA",
                        "use", "sig",
                        "kid", e.getKey(),
                        "x", Ed25519.rawPublicKey(e.getValue())))
                .toList();
        return Map.of("keys", keys);
    }
}
