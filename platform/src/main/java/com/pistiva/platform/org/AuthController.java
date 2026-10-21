package com.pistiva.platform.org;

import com.pistiva.platform.security.Principals;
import com.pistiva.platform.security.Principals.UserPrincipal;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
public class AuthController {

    private final OrgService orgService;

    public AuthController(OrgService orgService) {
        this.orgService = orgService;
    }

    public record RegisterRequest(@NotBlank @Email String email, @NotBlank @Size(min = 10, max = 200) String password,
                                  @NotBlank @Size(max = 200) String orgName, @NotBlank String domain) {
    }

    public record LoginRequest(@NotBlank String email, @NotBlank String password) {
    }

    public record TokenResponse(String accessToken) {
    }

    public record MeResponse(String userId, String email, boolean platformAdmin, List<OrgService.Membership> organizations) {
    }

    @PostMapping("/auth/register")
    public TokenResponse register(@Valid @RequestBody RegisterRequest req) {
        return new TokenResponse(orgService.register(req.email(), req.password(), req.orgName(), req.domain()));
    }

    @PostMapping("/auth/login")
    public TokenResponse login(@Valid @RequestBody LoginRequest req) {
        return new TokenResponse(orgService.login(req.email(), req.password()));
    }

    @GetMapping("/me")
    public MeResponse me() {
        UserPrincipal user = Principals.user();
        return new MeResponse(user.userId().toString(), user.email(), user.platformAdmin(), orgService.memberships(user.userId()));
    }
}
