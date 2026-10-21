package com.pistiva.platform.identity;

import com.pistiva.platform.common.Ed25519;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Key ids are derived from the public key so the same key always gets the same kid. */
public final class KeyIds {

    private KeyIds() {
    }

    public static String thumbprint(String rawPublicKey) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(rawPublicKey.getBytes(StandardCharsets.US_ASCII));
            return Ed25519.b64url(digest).substring(0, 22);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
