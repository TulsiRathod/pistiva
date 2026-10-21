package com.pistiva.platform.audit;

import com.fasterxml.jackson.databind.JsonNode;
import com.pistiva.platform.org.OrgService;
import com.pistiva.platform.security.Principals;
import com.pistiva.platform.task.ReceiptService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.data.domain.PageRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

@RestController
public class AuditController {

    private final AuditEventRepository events;
    private final OrgService orgService;
    private final ReceiptService receipts;

    public AuditController(AuditEventRepository events, OrgService orgService, ReceiptService receipts) {
        this.events = events;
        this.orgService = orgService;
        this.receipts = receipts;
    }

    public record ReceiptRequest(@NotNull JsonNode receipt,
                                 @NotBlank String providerKid, @NotBlank String providerSignature,
                                 @NotBlank String requesterKid, @NotBlank String requesterSignature) {
    }

    public record AuditEventView(UUID id, UUID taskId, String type, String actor, UUID requesterOrgId,
                                 UUID providerOrgId, String requestHash, String responseHash, String details,
                                 Instant createdAt) {
        static AuditEventView of(AuditEvent e) {
            return new AuditEventView(e.getId(), e.getTaskId(), e.getType(), e.getActor(), e.getRequesterOrgId(),
                    e.getProviderOrgId(), e.getRequestHash(), e.getResponseHash(), e.getDetailsJson(), e.getCreatedAt());
        }
    }

    @PostMapping("/audit/receipts")
    public ReceiptService.RecordedReceipt submitReceipt(@Valid @RequestBody ReceiptRequest req) {
        return receipts.record(Principals.agent(), new ReceiptService.SignedReceipt(req.receipt(),
                req.providerKid(), req.providerSignature(), req.requesterKid(), req.requesterSignature()));
    }

    /** An organization sees events where it was requester or provider, and nothing else. */
    @GetMapping("/audit")
    public List<AuditEventView> list(@RequestParam UUID orgId, @RequestParam(required = false) UUID taskId,
                                     @RequestParam(defaultValue = "100") int limit) {
        orgService.requireMember(Principals.user(), orgId);
        List<AuditEvent> found = taskId == null
                ? events.findForOrg(orgId, PageRequest.of(0, Math.min(Math.max(limit, 1), 500)))
                : events.findForOrgAndTask(orgId, taskId);
        return found.stream().map(AuditEventView::of).toList();
    }
}
