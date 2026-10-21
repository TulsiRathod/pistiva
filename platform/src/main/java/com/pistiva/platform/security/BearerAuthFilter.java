package com.pistiva.platform.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pistiva.platform.common.ApiException;
import com.pistiva.platform.identity.TokenService;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;
import java.util.Map;

/** Authenticates the Authorization: Bearer header as either a console user or an agent. */
public class BearerAuthFilter extends OncePerRequestFilter {

    private final TokenService tokens;
    private final ObjectMapper mapper = new ObjectMapper();

    public BearerAuthFilter(TokenService tokens) {
        this.tokens = tokens;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String header = request.getHeader("Authorization");
        if (header == null || !header.startsWith("Bearer ")) {
            chain.doFilter(request, response);
            return;
        }
        String token = header.substring("Bearer ".length()).trim();
        try {
            Object principal;
            String role;
            if (TokenService.AGENT_TYP.equals(tokens.typeOf(token))) {
                principal = tokens.verifyAgentAssertion(token);
                role = "ROLE_AGENT";
            } else {
                principal = tokens.verifyUserToken(token);
                role = "ROLE_USER";
            }
            var auth = new UsernamePasswordAuthenticationToken(principal, null, List.of(new SimpleGrantedAuthority(role)));
            SecurityContextHolder.getContext().setAuthentication(auth);
        } catch (ApiException e) {
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setContentType(MediaType.APPLICATION_JSON_VALUE);
            mapper.writeValue(response.getOutputStream(), Map.of("error", "unauthorized", "message", e.getMessage()));
            return;
        }
        chain.doFilter(request, response);
    }
}
