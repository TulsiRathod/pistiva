package com.pistiva.platform.billing;

import com.pistiva.platform.security.Principals;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.YearMonth;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;

@RestController
public class BillingController {

    private final BillingService billing;

    public BillingController(BillingService billing) {
        this.billing = billing;
    }

    public record MarkPaidRequest(UUID orgId, String period, String currency, String reference) {
    }

    private static String periodOrCurrent(String period) {
        return period == null || period.isBlank() ? YearMonth.now(ZoneOffset.UTC).toString() : period;
    }

    @GetMapping("/orgs/{orgId}/usage")
    public BillingService.OrgUsage usage(@PathVariable UUID orgId, @RequestParam(required = false) String period) {
        return billing.usage(Principals.user(), orgId, periodOrCurrent(period));
    }

    @GetMapping("/orgs/{orgId}/usage.csv")
    public ResponseEntity<String> usageCsv(@PathVariable UUID orgId, @RequestParam(required = false) String period) {
        String p = periodOrCurrent(period);
        return ResponseEntity.ok()
                .contentType(new MediaType("text", "csv"))
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"pistiva-usage-" + p + ".csv\"")
                .body(billing.usageCsv(Principals.user(), orgId, p));
    }

    @GetMapping("/admin/payouts")
    public List<BillingService.PayoutLine> payouts(@RequestParam(required = false) String period) {
        return billing.payouts(Principals.user(), periodOrCurrent(period));
    }

    @GetMapping("/admin/payouts.csv")
    public ResponseEntity<String> payoutsCsv(@RequestParam(required = false) String period) {
        String p = periodOrCurrent(period);
        return ResponseEntity.ok()
                .contentType(new MediaType("text", "csv"))
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"pistiva-payouts-" + p + ".csv\"")
                .body(billing.payoutsCsv(Principals.user(), p));
    }

    @PostMapping("/admin/payouts")
    public BillingService.Paid markPaid(@RequestBody MarkPaidRequest req) {
        return billing.markPaid(Principals.user(), req.orgId(), periodOrCurrent(req.period()), req.currency(), req.reference());
    }
}
