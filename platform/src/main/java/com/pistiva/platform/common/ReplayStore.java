package com.pistiva.platform.common;

/** Remembers single-use identifiers (assertion jti, nonces) until they expire. */
public interface ReplayStore {

    /** Returns true the first time an id is seen, false on replay. */
    boolean firstUse(String id, long expiresAtEpochSecond);
}