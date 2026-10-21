package com.pistiva.platform.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;

/**
 * Lets a Prometheus scraper read {@code /actuator/prometheus} with a static bearer token
 * ({@code pistiva.metrics.token}). Without a configured token the endpoint stays closed.
 */
public class MetricsTokenFilter extends OncePerRequestFilter {

    public static final String PATH = "/actuator/prometheus";
    public static final String ROLE = "METRICS";

    private final byte[] expected;

    public MetricsTokenFilter(String token) {
        this.expected = token == null || token.isBlank() ? null : ("Bearer " + token.trim()).getBytes(StandardCharsets.UTF_8);
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !PATH.equals(request.getRequestURI());
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String header = request.getHeader("Authorization");
        if (expected != null && header != null && MessageDigest.isEqual(expected, header.getBytes(StandardCharsets.UTF_8))) {
            SecurityContextHolder.getContext().setAuthentication(
                    new UsernamePasswordAuthenticationToken("metrics-scraper", null, List.of(new SimpleGrantedAuthority("ROLE_" + ROLE))));
        }
        chain.doFilter(request, response);
    }
}
