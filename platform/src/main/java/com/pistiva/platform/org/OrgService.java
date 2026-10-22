package com.pistiva.platform.org;

import com.pistiva.platform.audit.AuditService;
import com.pistiva.platform.common.ApiException;
import com.pistiva.platform.common.Ed25519;
import com.pistiva.platform.identity.TokenService;
import com.pistiva.platform.org.OrgMember.Role;
import com.pistiva.platform.policy.PolicyService;
import com.pistiva.platform.security.LoginThrottle;
import com.pistiva.platform.security.Principals.UserPrincipal;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.security.SecureRandom;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

@Service
public class OrgService {

    private final LoginThrottle throttle;

    private static final Pattern DOMAIN = Pattern.compile("^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$");
    private static final SecureRandom RANDOM = new SecureRandom();

    private final OrganizationRepository orgs;
    private final UserRepository users;
    private final OrgMemberRepository members;
    private final PasswordEncoder passwordEncoder;
    private final TokenService tokens;
    private final PolicyService policies;
    private final DnsVerifier dns;
    private final AuditService audit;

    public OrgService(OrganizationRepository orgs, UserRepository users, OrgMemberRepository members,
                      PasswordEncoder passwordEncoder, TokenService tokens, PolicyService policies,
                      DnsVerifier dns, AuditService audit, LoginThrottle throttle) {
        this.throttle = throttle;
        this.orgs = orgs;
        this.users = users;
        this.members = members;
        this.passwordEncoder = passwordEncoder;
        this.tokens = tokens;
        this.policies = policies;
        this.dns = dns;
        this.audit = audit;
    }

    public record Membership(UUID orgId, String orgName, String domain, String verificationStatus, String status, Role role) {
    }

    /** Creates a user and their organization (as OWNER). The org starts PENDING verification. */
    @Transactional
    public String register(String email, String password, String orgName, String domain) {
        String normalizedEmail = email.trim().toLowerCase();
        String normalizedDomain = normalizeDomain(domain);
        if (users.findByEmail(normalizedEmail).isPresent()) {
            throw new ApiException.Conflict("Email already registered");
        }
        if (orgs.existsByDomain(normalizedDomain)) {
            throw new ApiException.Conflict("Domain already registered");
        }
        User user = users.save(new User(normalizedEmail, passwordEncoder.encode(password), false));
        Organization org = orgs.save(new Organization(orgName.trim(), normalizedDomain, randomToken()));
        members.save(new OrgMember(org.getId(), user.getId(), Role.OWNER));
        policies.createDefault(org.getId());
        audit.record("ORG_CREATED", "user:" + user.getId(), org.getId(), Map.of("domain", normalizedDomain));
        return tokens.issueUserToken(user);
    }

    public String login(String email, String password) {
        String key = email.trim().toLowerCase();
        throttle.check(key);
        User user = users.findByEmail(key)
                .filter(u -> passwordEncoder.matches(password, u.getPasswordHash()))
                .orElse(null);
        if (user == null) {
            throttle.failed(key);
            throw new ApiException.Unauthorized("Invalid email or password");
        }
        throttle.succeeded(key);
        return tokens.issueUserToken(user);
    }

    public List<Membership> memberships(UUID userId) {
        return members.findByUserId(userId).stream()
                .map(m -> {
                    Organization org = orgs.findById(m.getOrgId()).orElseThrow();
                    return new Membership(org.getId(), org.getName(), org.getDomain(),
                            org.getVerificationStatus().name(), org.getStatus().name(), m.getRole());
                })
                .toList();
    }

    public Organization get(UUID orgId) {
        return orgs.findById(orgId).orElseThrow(() -> new ApiException.NotFound("Organization not found"));
    }

    /** Throws unless the user holds one of the roles in the org. Platform admins pass every check. */
    public void requireRole(UserPrincipal user, UUID orgId, Set<Role> allowed) {
        if (user.platformAdmin()) {
            get(orgId);
            return;
        }
        OrgMember member = members.findByOrgIdAndUserId(orgId, user.userId())
                .orElseThrow(() -> new ApiException.Forbidden("Not a member of this organization"));
        if (!allowed.contains(member.getRole())) {
            throw new ApiException.Forbidden("Role " + member.getRole() + " cannot perform this action");
        }
    }

    public void requireMember(UserPrincipal user, UUID orgId) {
        requireRole(user, orgId, Set.of(Role.values()));
    }

    @Transactional
    public Organization verify(UserPrincipal user, UUID orgId, String method) {
        Organization org = get(orgId);
        switch (method) {
            case "dns" -> {
                requireRole(user, orgId, Role.MANAGE_ORG);
                if (!dns.hasToken(org.getDomain(), org.getVerificationToken())) {
                    throw new ApiException.BadRequest("TXT record _pistiva-verification." + org.getDomain()
                            + " with value pistiva-verification=" + org.getVerificationToken() + " not found");
                }
            }
            case "manual" -> {
                if (!user.platformAdmin()) {
                    throw new ApiException.Forbidden("Manual verification requires a platform admin");
                }
            }
            default -> throw new ApiException.BadRequest("method must be dns or manual");
        }
        org.markVerified();
        audit.record("ORG_VERIFIED", "user:" + user.userId(), orgId, Map.of("method", method));
        return org;
    }

    @Transactional
    public Organization setStatus(UserPrincipal user, UUID orgId, Organization.Status status) {
        if (!user.platformAdmin()) {
            throw new ApiException.Forbidden("Changing organization status requires a platform admin");
        }
        Organization org = get(orgId);
        org.setStatus(status);
        audit.record("ORG_STATUS_CHANGED", "user:" + user.userId(), orgId, Map.of("status", status.name()));
        return org;
    }

    @Transactional
    public OrgMember addMember(UserPrincipal user, UUID orgId, String email, Role role) {
        requireRole(user, orgId, Role.MANAGE_ORG);
        if (role == Role.OWNER) {
            throw new ApiException.BadRequest("Ownership cannot be granted through this endpoint");
        }
        User invitee = users.findByEmail(email.trim().toLowerCase())
                .orElseThrow(() -> new ApiException.NotFound("No user with that email; they must register first"));
        if (members.findByOrgIdAndUserId(orgId, invitee.getId()).isPresent()) {
            throw new ApiException.Conflict("User is already a member");
        }
        OrgMember member = members.save(new OrgMember(orgId, invitee.getId(), role));
        audit.record("MEMBER_ADDED", "user:" + user.userId(), orgId, Map.of("member", invitee.getId(), "role", role.name()));
        return member;
    }

    public List<OrgMember> listMembers(UserPrincipal user, UUID orgId) {
        requireMember(user, orgId);
        return members.findByOrgId(orgId);
    }

    private static String normalizeDomain(String domain) {
        String d = domain.trim().toLowerCase();
        if (!DOMAIN.matcher(d).matches()) {
            throw new ApiException.BadRequest("Invalid domain");
        }
        return d;
    }

    private static String randomToken() {
        byte[] bytes = new byte[24];
        RANDOM.nextBytes(bytes);
        return Ed25519.b64url(bytes);
    }
}
