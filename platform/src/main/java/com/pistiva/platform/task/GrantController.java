package com.pistiva.platform.task;

import com.pistiva.platform.identity.PlatformKeyService;
import com.pistiva.platform.security.Principals;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.math.BigDecimal;
import java.util.Map;
import java.util.UUID;

@RestController
public class GrantController {

    private final GrantService grantService;
    private final PlatformKeyService platformKeys;

    public GrantController(GrantService grantService, PlatformKeyService platformKeys) {
        this.grantService = grantService;
        this.platformKeys = platformKeys;
    }

    /** Budget is a decimal string, never a float, so amounts are exact on every side. */
    public record CreateGrantRequest(@NotNull UUID providerAgentId, @NotBlank String capability,
                                     @NotNull @DecimalMin("0") BigDecimal budget, @NotBlank String currency,
                                     UUID continueTaskId) {
    }

    @PostMapping("/grants")
    public GrantService.IssuedGrant create(@Valid @RequestBody CreateGrantRequest req) {
        return grantService.issue(Principals.agent(),
                new GrantService.GrantRequest(req.providerAgentId(), req.capability(), req.budget(), req.currency(),
                        req.continueTaskId()));
    }

    /** Gateways verify grants offline against this key set. */
    @GetMapping("/.well-known/jwks.json")
    public Map<String, Object> jwks() {
        return platformKeys.jwks();
    }
}
