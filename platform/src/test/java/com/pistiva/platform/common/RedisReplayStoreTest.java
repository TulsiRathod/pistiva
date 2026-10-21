package com.pistiva.platform.common;

import org.junit.jupiter.api.Test;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/** Two platform instances sharing Redis must refuse an assertion the other already accepted. */
@Testcontainers(disabledWithoutDocker = true)
class RedisReplayStoreTest {

    @Container
    static GenericContainer<?> redis = new GenericContainer<>("redis:7-alpine").withExposedPorts(6379);

    @Test
    void sharedStoreRejectsReplaysAcrossInstances() {
        ReplayStore instanceA = store();
        ReplayStore instanceB = store();
        long exp = Instant.now().getEpochSecond() + 60;
        assertThat(instanceA.firstUse("kid:jti-1", exp)).isTrue();
        assertThat(instanceB.firstUse("kid:jti-1", exp)).isFalse();
        assertThat(instanceB.firstUse("kid:jti-2", exp)).isTrue();
    }

    private static ReplayStore store() {
        LettuceConnectionFactory f = new LettuceConnectionFactory(new RedisStandaloneConfiguration(redis.getHost(), redis.getMappedPort(6379)));
        f.afterPropertiesSet();
        f.start();
        return new RedisReplayStore(new StringRedisTemplate(f));
    }
}