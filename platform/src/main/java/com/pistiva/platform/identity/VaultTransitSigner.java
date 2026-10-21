package com.pistiva.platform.identity;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pistiva.platform.common.Ed25519;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.PublicKey;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Signs with an Ed25519 key held by HashiCorp Vault's (or OpenBao's) Transit engine. The private
 * key never leaves the key store, which can itself be backed by an HSM.
 *
 * <p>Every version of the Transit key stays in the verification set, so rotating it in Vault
 * (`vault write -f transit/keys/&lt;name&gt;/rotate`) switches new signatures to the new version while
 * outstanding grants and tokens keep verifying. Versions are re-read every few minutes.
 */
public class VaultTransitSigner implements PlatformSigner {

    private static final Duration REFRESH = Duration.ofMinutes(5);

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final ObjectMapper mapper = new ObjectMapper();
    private final URI base;
    private final String token;
    private final String mount;
    private final String keyName;

    private volatile Keys keys;

    private record Keys(int latest, String currentKid, Map<String, PublicKey> byKid, Instant loadedAt) {
    }

    public VaultTransitSigner(String address, String token, String mount, String keyName) {
        if (address == null || address.isBlank() || token == null || token.isBlank() || keyName == null || keyName.isBlank()) {
            throw new IllegalStateException("Vault Transit signing needs pistiva.signing.vault.address, token and key");
        }
        this.base = URI.create(address.replaceAll("/+$", "") + "/");
        this.token = token;
        this.mount = mount == null || mount.isBlank() ? "transit" : mount;
        this.keyName = keyName;
        this.keys = load();
        // Fail at startup, not on the first grant, if the key cannot sign or the signature does not verify.
        byte[] probe = ("pistiva-signer-self-test:" + Instant.now()).getBytes();
        if (!Ed25519.verify(keys.byKid().get(keys.currentKid()), probe, sign(probe))) {
            throw new IllegalStateException("Vault Transit key " + keyName + " produced a signature that does not verify");
        }
    }

    @Override
    public String currentKid() {
        return current().currentKid();
    }

    @Override
    public byte[] sign(byte[] data) {
        Keys k = current();
        String body = mapper.createObjectNode()
                .put("input", Base64.getEncoder().encodeToString(data))
                .put("key_version", k.latest())
                .toString();
        JsonNode res = call("POST", mount + "/sign/" + keyName, body);
        // "vault:v<version>:<base64 signature>"
        String signature = res.path("data").path("signature").asText();
        String expectedPrefix = "vault:v" + k.latest() + ":";
        if (!signature.startsWith(expectedPrefix)) {
            throw new IllegalStateException("Vault signed with an unexpected key version");
        }
        return Base64.getDecoder().decode(signature.substring(expectedPrefix.length()));
    }

    @Override
    public Map<String, PublicKey> verificationKeys() {
        return current().byKid();
    }

    @Override
    public String describe() {
        return "Vault Transit key " + mount + "/" + keyName + " v" + keys.latest() + " at " + base;
    }

    private Keys current() {
        Keys k = keys;
        if (k.loadedAt().plus(REFRESH).isBefore(Instant.now())) {
            try {
                k = load();
                keys = k;
            } catch (RuntimeException e) {
                // Keep signing with what we have; Vault being briefly unreachable must not drop known keys.
            }
        }
        return k;
    }

    private Keys load() {
        JsonNode data = call("GET", mount + "/keys/" + keyName, null).path("data");
        if (!"ed25519".equals(data.path("type").asText())) {
            throw new IllegalStateException("Vault Transit key " + keyName + " must be of type ed25519, not " + data.path("type").asText());
        }
        int latest = data.path("latest_version").asInt();
        Map<String, PublicKey> byKid = new LinkedHashMap<>();
        String currentKid = null;
        for (Iterator<Map.Entry<String, JsonNode>> it = data.path("keys").fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> version = it.next();
            byte[] raw = Base64.getDecoder().decode(version.getValue().path("public_key").asText());
            PublicKey key = Ed25519.publicKeyFromRaw(Ed25519.b64url(raw));
            String kid = PlatformSigner.kidFor(key);
            byKid.put(kid, key);
            if (Integer.parseInt(version.getKey()) == latest) {
                currentKid = kid;
            }
        }
        if (currentKid == null) {
            throw new IllegalStateException("Vault Transit key " + keyName + " has no public key for its latest version");
        }
        return new Keys(latest, currentKid, Map.copyOf(byKid), Instant.now());
    }

    private JsonNode call(String method, String path, String body) {
        HttpRequest.Builder req = HttpRequest.newBuilder(base.resolve("v1/" + path))
                .timeout(Duration.ofSeconds(10))
                .header("X-Vault-Token", token);
        if (body == null) {
            req.GET();
        } else {
            req.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(body));
        }
        try {
            HttpResponse<String> res = http.send(req.build(), HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() / 100 != 2) {
                throw new IllegalStateException("Vault " + method + " " + path + " returned HTTP " + res.statusCode());
            }
            return mapper.readTree(res.body());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted calling Vault", e);
        } catch (java.io.IOException e) {
            throw new IllegalStateException("Vault unreachable: " + e.getMessage(), e);
        }
    }
}
