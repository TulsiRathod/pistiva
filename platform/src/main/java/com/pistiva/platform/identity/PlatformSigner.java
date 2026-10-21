package com.pistiva.platform.identity;

import java.security.PublicKey;
import java.util.Map;

/**
 * Custody of the platform's Ed25519 signing key. The platform never needs the private key itself,
 * only signatures, so the key can live in a KMS or HSM that signs on request.
 */
public interface PlatformSigner {

    /** Key id of the current signing key; new grants and tokens carry it. */
    String currentKid();

    /** Signs with the current key. */
    byte[] sign(byte[] data);

    /** Every key whose signatures are still accepted, by key id: the current key and, after a rotation, earlier ones. */
    Map<String, PublicKey> verificationKeys();

    /** Where the key lives, for the startup log. Never contains secrets. */
    String describe();

    static String kidFor(PublicKey key) {
        return "platform-" + KeyIds.thumbprint(com.pistiva.platform.common.Ed25519.rawPublicKey(key));
    }
}
