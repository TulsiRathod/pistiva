package com.pistiva.platform.common;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.net.URI;

/** Picks the replay store: Redis when pistiva.redis.url is set, in memory otherwise. */
@Configuration
public class ReplayStoreConfig {

    @Bean
    ReplayStore replayStore(@Value("${pistiva.redis.url:}") String redisUrl) {
        if (redisUrl == null || redisUrl.isBlank()) {
            return new ReplayCache();
        }
        URI uri = URI.create(redisUrl);
        RedisStandaloneConfiguration server = new RedisStandaloneConfiguration(uri.getHost(), uri.getPort() > 0 ? uri.getPort() : 6379);
        if (uri.getUserInfo() != null) {
            String[] parts = uri.getUserInfo().split(":", 2);
            if (parts.length == 2) {
                if (!parts[0].isEmpty()) {
                    server.setUsername(parts[0]);
                }
                server.setPassword(parts[1]);
            } else {
                server.setPassword(parts[0]);
            }
        }
        LettuceClientConfiguration.LettuceClientConfigurationBuilder client = LettuceClientConfiguration.builder();
        if ("rediss".equals(uri.getScheme())) {
            client.useSsl();
        }
        LettuceConnectionFactory factory = new LettuceConnectionFactory(server, client.build());
        factory.afterPropertiesSet();
        factory.start();
        return new RedisReplayStore(new StringRedisTemplate(factory));
    }
}