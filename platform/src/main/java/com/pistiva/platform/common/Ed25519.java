package com.pistiva.platform.common;

import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.NamedParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Base64;

/**
 * Ed25519 helpers using the JDK provider. Public keys travel as base64url of the raw
 * 32-byte key, the same form as the JWK "x" member, so the TypeScript SDK can use them directly.
 */
public final class Ed25519 {

    private static final byte[] X509_PREFIX = hex("302a300506032b6570032100");
    private static final byte[] PKCS8_PREFIX = hex("302e020100300506032b657004220420");

    private Ed25519() {
    }

    public static KeyPair generate() {
        try {
            return KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    public static String rawPublicKey(PublicKey key) {
        byte[] encoded = key.getEncoded();
        return b64url(Arrays.copyOfRange(encoded, X509_PREFIX.length, encoded.length));
    }

    public static PublicKey publicKeyFromRaw(String rawB64url) {
        byte[] raw = b64urlDecode(rawB64url);
        if (raw.length != 32) {
            throw new IllegalArgumentException("Ed25519 public key must be 32 bytes");
        }
        try {
            return KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(concat(X509_PREFIX, raw)));
        } catch (GeneralSecurityException e) {
            throw new IllegalArgumentException("Invalid Ed25519 public key", e);
        }
    }

    public static String rawPrivateSeed(PrivateKey key) {
        byte[] encoded = key.getEncoded();
        return b64url(Arrays.copyOfRange(encoded, encoded.length - 32, encoded.length));
    }

    public static PrivateKey privateKeyFromSeed(String seedB64url) {
        byte[] seed = b64urlDecode(seedB64url);
        try {
            return KeyFactory.getInstance("Ed25519").generatePrivate(new PKCS8EncodedKeySpec(concat(PKCS8_PREFIX, seed)));
        } catch (GeneralSecurityException e) {
            throw new IllegalArgumentException("Invalid Ed25519 private key", e);
        }
    }

    /**
     * Derives the public key for a seed. The JDK has no direct API for this, so the key pair
     * generator is fed the seed as its "random" bytes, which reproduces the same pair.
     */
    public static PublicKey publicKeyFromSeed(String seedB64url) {
        byte[] seed = b64urlDecode(seedB64url);
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("Ed25519");
            generator.initialize(NamedParameterSpec.ED25519, new SecureRandom() {
                @Override
                public void nextBytes(byte[] bytes) {
                    System.arraycopy(seed, 0, bytes, 0, Math.min(seed.length, bytes.length));
                }
            });
            return generator.generateKeyPair().getPublic();
        } catch (GeneralSecurityException e) {
            throw new IllegalArgumentException("Invalid Ed25519 seed", e);
        }
    }

    public static byte[] sign(PrivateKey key, byte[] data) {
        try {
            Signature signature = Signature.getInstance("Ed25519");
            signature.initSign(key);
            signature.update(data);
            return signature.sign();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    public static boolean verify(PublicKey key, byte[] data, byte[] sig) {
        try {
            Signature signature = Signature.getInstance("Ed25519");
            signature.initVerify(key);
            signature.update(data);
            return signature.verify(sig);
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            return false;
        }
    }

    public static String b64url(byte[] data) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(data);
    }

    public static byte[] b64urlDecode(String data) {
        return Base64.getUrlDecoder().decode(data);
    }

    private static byte[] concat(byte[] a, byte[] b) {
        byte[] out = Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    private static byte[] hex(String s) {
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }
}
