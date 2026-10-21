package com.pistiva.platform.approval;

import com.fasterxml.jackson.databind.JsonNode;
import com.pistiva.platform.security.Principals;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

@RestController
public class ApprovalController {

    private final ApprovalService approvals;

    public ApprovalController(ApprovalService approvals) {
        this.approvals = approvals;
    }

    public record CreateApprovalRequest(@NotNull UUID providerAgentId, @NotBlank String capability,
                                        @NotBlank @Size(max = 100) String reference,
                                        @NotNull @DecimalMin("0.01") BigDecimal amount,
                                        @NotBlank @Pattern(regexp = "[A-Z]{3}") String currency, JsonNode summary) {
    }

    public record DecisionRequest(@NotNull Approval.Status decision, @Size(max = 1000) String comment) {
    }

    public record ApprovalView(UUID id, UUID orgId, UUID requesterAgentId, UUID providerAgentId, String capability,
                               String reference, String amount, String currency, String summary, String status,
                               Instant requestedAt, UUID decidedBy, Instant decidedAt, String comment, boolean used) {
        static ApprovalView of(Approval a) {
            return new ApprovalView(a.getId(), a.getOrgId(), a.getRequesterAgentId(), a.getProviderAgentId(),
                    a.getCapability(), a.getReference(), a.getAmount().toPlainString(), a.getCurrency(), a.getSummary(),
                    a.getStatus().name(), a.getRequestedAt(), a.getDecidedBy(), a.getDecidedAt(), a.getComment(),
                    a.getConsumedByGrant() != null);
        }
    }

    /** An agent asks its organization's approvers to authorize a commitment. */
    @PostMapping("/approvals")
    public ApprovalView request(@Valid @RequestBody CreateApprovalRequest req) {
        return ApprovalView.of(approvals.request(Principals.agent(), new ApprovalService.ApprovalRequest(
                req.providerAgentId(), req.capability(), req.reference(), req.amount(), req.currency(), req.summary())));
    }

    @GetMapping("/approvals/{id}")
    public ApprovalView get(@PathVariable UUID id) {
        return ApprovalView.of(approvals.get(Principals.current(), id));
    }

    @GetMapping("/approvals")
    public List<ApprovalView> list(@RequestParam UUID orgId, @RequestParam(required = false) Approval.Status status) {
        return approvals.list(Principals.user(), orgId, status).stream().map(ApprovalView::of).toList();
    }

    @PostMapping("/approvals/{id}/decision")
    public ApprovalView decide(@PathVariable UUID id, @Valid @RequestBody DecisionRequest req) {
        return ApprovalView.of(approvals.decide(Principals.user(), id, req.decision(), req.comment()));
    }
}
