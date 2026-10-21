package com.pistiva.platform.security;

import com.pistiva.platform.common.ApiException;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

import java.util.UUID;

/** The two kinds of caller: a console user, or an agent authenticating with its own key. */
public final class Principals {

    private Principals() {
    }

    public record UserPrincipal(UUID userId, String email, boolean platformAdmin) {
    }

    public record AgentPrincipal(UUID agentId, UUID orgId, String kid) {
    }

    public static UserPrincipal user() {
        if (current() instanceof UserPrincipal user) {
            return user;
        }
        throw new ApiException.Forbidden("This endpoint requires a user session");
    }

    public static AgentPrincipal agent() {
        if (current() instanceof AgentPrincipal agent) {
            return agent;
        }
        throw new ApiException.Forbidden("This endpoint requires agent authentication");
    }

    public static Object current() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null) {
            throw new ApiException.Unauthorized("Not authenticated");
        }
        return auth.getPrincipal();
    }
}
