package com.pistiva.platform.security;

import com.pistiva.platform.common.ApiException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Slows password guessing: after {@code max-failures} wrong passwords for an email within the window,
 * further attempts for it are refused until the window passes, even with the right password. Kept in
 * memory per instance, so the limit is per replica; it bounds guessing, it is not an account lockout.
 */
@Component
public class LoginThrottle {

    private final ConcurrentHashMap<String, Deque<Long>> failures = new ConcurrentHashMap<>();
    private final int maxFailures;
    private final long windowMillis;

    public LoginThrottle(@Value("${pistiva.login.max-failures:10}") int maxFailures,
                         @Value("${pistiva.login.window:15m}") Duration window) {
        this.maxFailures = maxFailures;
        this.windowMillis = window.toMillis();
    }

    /** Throws 429 when the email has too many recent failures. */
    public void check(String email) {
        Deque<Long> recent = failures.get(email);
        if (recent == null) {
            return;
        }
        synchronized (recent) {
            prune(recent);
            if (recent.size() >= maxFailures) {
                throw new ApiException.TooManyRequests("Too many failed sign-in attempts; try again in a few minutes");
            }
        }
    }

    public void failed(String email) {
        if (failures.size() > 50_000) {
            failures.entrySet().removeIf(e -> {
                synchronized (e.getValue()) {
                    prune(e.getValue());
                    return e.getValue().isEmpty();
                }
            });
        }
        Deque<Long> recent = failures.computeIfAbsent(email, k -> new ArrayDeque<>());
        synchronized (recent) {
            recent.addLast(System.currentTimeMillis());
        }
    }

    public void succeeded(String email) {
        failures.remove(email);
    }

    private void prune(Deque<Long> recent) {
        long cutoff = System.currentTimeMillis() - windowMillis;
        while (!recent.isEmpty() && recent.peekFirst() < cutoff) {
            recent.pollFirst();
        }
    }
}
