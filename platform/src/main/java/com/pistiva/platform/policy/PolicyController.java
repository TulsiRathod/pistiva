package com.pistiva.platform.policy;

import com.pistiva.platform.audit.AuditService;
import com.pistiva.platform.org.OrgMember.Role;
import com.pistiva.platform.org.OrgService;
import com.pistiva.platform.security.Principals;
import com.pistiva.platform.security.Principals.UserPrincipal;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;
import java.util.UUID;

@RestController
public class PolicyController {

    private final PolicyService policies;
    private final OrgService orgService;
    private final AuditService audit;

    public PolicyController(PolicyService policies, OrgService orgService, AuditService audit) {
        this.policies = policies;
        this.orgService = orgService;
        this.audit = audit;
    }

    @GetMapping("/orgs/{id}/policy")
    public PolicyRules get(@PathVariable UUID id) {
        orgService.requireMember(Principals.user(), id);
        return policies.get(id);
    }

    @PutMapping("/orgs/{id}/policy")
    public PolicyRules update(@PathVariable UUID id, @Valid @RequestBody PolicyRules rules) {
        UserPrincipal user = Principals.user();
        orgService.requireRole(user, id, Role.MANAGE_ORG);
        PolicyRules saved = policies.update(id, rules);
        audit.record("POLICY_UPDATED", "user:" + user.userId(), id, Map.of("rules", saved));
        return saved;
    }
}
