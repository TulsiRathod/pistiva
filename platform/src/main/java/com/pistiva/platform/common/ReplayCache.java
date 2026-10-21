package com.pistiva.platform.common;

import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Remembers one-time identifiers until they expire. Single-node only; a multi-node deployment
 * needs a shared store (for example Redis SET NX with TTL).
 */
public class ReplayCache {

    private static final int PURGE_THRESHOLD = 10_000;

    private final Map<String, Long> seen = new ConcurrentHashMap<>();

    /** Returns true the first time an id is seen, false on replay. */
    public boolean firstUse(String id, long expiresAtEpochSecond) {
        long now = Instant.now().getEpochSecond();
        if (seen.size() > PURGE_THRESHOLD) {
            seen.values().removeIf(exp -> exp < now);
        }
        return seen.putIfAbsent(id, expiresAtEpochSecond) == null;
    }
}
