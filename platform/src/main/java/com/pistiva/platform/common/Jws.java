package com.pistiva.platform.common;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.time.Instant;
import java.util.function.Function;

/** Minimal compact JWS (RFC 7515) with alg=EdDSA only. */
public final class Jws {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private Jws() {
    }

    public record Parsed(JsonNode header, JsonNode payload) {
    }

    public static String sign(String typ, String kid, ObjectNode payload, PrivateKey key) {
        return sign(typ, kid, payload, data -> Ed25519.sign(key, data));
    }

    /** Signs with an external signer, e.g. a KMS that holds the private key. */
    public static String sign(String typ, String kid, ObjectNode payload, Function<byte[], byte[]> signer) {
        ObjectNode header = MAPPER.createObjectNode().put("alg", "EdDSA").put("typ", typ).put("kid", kid);
        String signingInput = encode(header) + "." + encode(payload);
        byte[] sig = signer.apply(signingInput.getBytes(StandardCharsets.US_ASCII));
        return signingInput + "." + Ed25519.b64url(sig);
    }

    /**
     * Verifies signature, typ and exp. The key resolver receives the header and returns the
     * verification key, or null when the kid is unknown or revoked.
     */
    public static Parsed verify(String token, String expectedTyp, Function<JsonNode, PublicKey> keyResolver) {
        String[] parts = token.split("\\.");
        if (parts.length != 3) {
            throw new ApiException.Unauthorized("Malformed token");
        }
        JsonNode header;
        JsonNode payload;
        try {
            header = MAPPER.readTree(Ed25519.b64urlDecode(parts[0]));
            payload = MAPPER.readTree(Ed25519.b64urlDecode(parts[1]));
        } catch (Exception e) {
            throw new ApiException.Unauthorized("Malformed token");
        }
        if (!"EdDSA".equals(header.path("alg").asText()) || !expectedTyp.equals(header.path("typ").asText())) {
            throw new ApiException.Unauthorized("Unexpected token type");
        }
        PublicKey key = keyResolver.apply(header);
        if (key == null) {
            throw new ApiException.Unauthorized("Unknown or revoked key");
        }
        byte[] sig;
        try {
            sig = Ed25519.b64urlDecode(parts[2]);
        } catch (IllegalArgumentException e) {
            throw new ApiException.Unauthorized("Malformed token");
        }
        if (!Ed25519.verify(key, (parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII), sig)) {
            throw new ApiException.Unauthorized("Bad signature");
        }
        if (!payload.has("exp") || payload.get("exp").asLong() < Instant.now().getEpochSecond()) {
            throw new ApiException.Unauthorized("Token expired");
        }
        return new Parsed(header, payload);
    }

    private static String encode(JsonNode node) {
        try {
            return Ed25519.b64url(MAPPER.writeValueAsString(node).getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
