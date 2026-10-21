package com.pistiva.platform.org;

import com.pistiva.platform.common.ApiException;
import com.pistiva.platform.org.OrgMember.Role;
import com.pistiva.platform.security.Principals;
import com.pistiva.platform.security.Principals.UserPrincipal;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/orgs")
public class OrgController {

    private final OrgService orgService;
    private final OrganizationRepository orgs;

    public OrgController(OrgService orgService, OrganizationRepository orgs) {
        this.orgService = orgService;
        this.orgs = orgs;
    }

    public record OrgView(UUID id, String name, String domain, String verificationStatus, String status,
                          String verificationRecord) {
        static OrgView of(Organization o, boolean includeToken) {
            return new OrgView(o.getId(), o.getName(), o.getDomain(), o.getVerificationStatus().name(),
                    o.getStatus().name(),
                    includeToken ? "_pistiva-verification." + o.getDomain() + " TXT pistiva-verification=" + o.getVerificationToken() : null);
        }
    }

    public record VerifyRequest(@NotBlank String method) {
    }

    public record StatusRequest(@NotNull Organization.Status status) {
    }

    public record AddMemberRequest(@NotBlank String email, @NotNull Role role) {
    }

    public record MemberView(UUID userId, Role role) {
    }

    /** Platform admins see every organization (for verification and abuse handling). */
    @GetMapping
    public List<OrgView> list() {
        UserPrincipal user = Principals.user();
        if (!user.platformAdmin()) {
            throw new ApiException.Forbidden("Listing all organizations requires a platform admin");
        }
        return orgs.findAll().stream().map(o -> OrgView.of(o, false)).toList();
    }

    @GetMapping("/{id}")
    public OrgView get(@PathVariable UUID id) {
        UserPrincipal user = Principals.user();
        orgService.requireMember(user, id);
        return OrgView.of(orgService.get(id), true);
    }

    @PostMapping("/{id}/verify")
    public OrgView verify(@PathVariable UUID id, @Valid @RequestBody VerifyRequest req) {
        return OrgView.of(orgService.verify(Principals.user(), id, req.method()), false);
    }

    @PostMapping("/{id}/status")
    public OrgView setStatus(@PathVariable UUID id, @Valid @RequestBody StatusRequest req) {
        return OrgView.of(orgService.setStatus(Principals.user(), id, req.status()), false);
    }

    @GetMapping("/{id}/members")
    public List<MemberView> members(@PathVariable UUID id) {
        return orgService.listMembers(Principals.user(), id).stream()
                .map(m -> new MemberView(m.getUserId(), m.getRole())).toList();
    }

    @PostMapping("/{id}/members")
    public MemberView addMember(@PathVariable UUID id, @Valid @RequestBody AddMemberRequest req) {
        OrgMember m = orgService.addMember(Principals.user(), id, req.email(), req.role());
        return new MemberView(m.getUserId(), m.getRole());
    }
}
