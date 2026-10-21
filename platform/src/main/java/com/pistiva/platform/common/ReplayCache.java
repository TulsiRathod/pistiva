package com.pistiva.platform.common;

import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * In-memory replay store: the default for a single platform instance. Several instances share
 * {@link RedisReplayStore} instead (pistiva.redis.url).
 */
public class ReplayCache implements ReplayStore {

    private static final int PURGE_THRESHOLD = 10_000;

    private final Map<String, Long> seen = new ConcurrentHashMap<>();

    @Override
    public boolean firstUse(String id, long expiresAtEpochSecond) {
        long now = Instant.now().getEpochSecond();
        if (seen.size() > PURGE_THRESHOLD) {
            seen.values().removeIf(exp -> exp < now);
        }
        return seen.putIfAbsent(id, expiresAtEpochSecond) == null;
    }
}
