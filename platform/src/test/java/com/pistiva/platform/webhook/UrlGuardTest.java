package com.pistiva.platform.webhook;

import org.junit.jupiter.api.Test;

import java.net.URI;

import static org.assertj.core.api.Assertions.assertThat;

class UrlGuardTest {

    @Test
    void refusesHostsThatPointInsideTheNetworkAndAcceptsPublicOnes() {
        for (String host : new String[] {"127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "[::1]", "[fd00::1]", "[fe80::1]"}) {
            assertThat(UrlGuard.problem(URI.create("https://" + host + "/hook"))).as(host).isNotNull();
        }
        assertThat(UrlGuard.problem(URI.create("https://8.8.8.8/hook"))).isNull();
        assertThat(UrlGuard.problem(URI.create("https:///no-host"))).isNotNull();
    }
}
