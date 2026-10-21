package com.pistiva.platform.common;

import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Duration;
import java.time.Instant;

/** Replay store shared by every platform instance: SET NX with a TTL that ends when the id expires. */
public class RedisReplayStore implements ReplayStore {

    private final StringRedisTemplate redis;

    public RedisReplayStore(StringRedisTemplate redis) {
        this.redis = redis;
    }

    @Override
    public boolean firstUse(String id, long expiresAtEpochSecond) {
        long ttl = Math.max(1, expiresAtEpochSecond - Instant.now().getEpochSecond() + 30);
        Boolean first = redis.opsForValue().setIfAbsent("pistiva:replay:" + id, "1", Duration.ofSeconds(ttl));
        return Boolean.TRUE.equals(first);
    }
}