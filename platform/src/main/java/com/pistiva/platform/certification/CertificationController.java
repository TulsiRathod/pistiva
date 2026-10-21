package com.pistiva.platform.certification;

import com.fasterxml.jackson.databind.JsonNode;
import com.pistiva.platform.certification.CertificationService.Certification;
import com.pistiva.platform.security.Principals;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
public class CertificationController {

    private final CertificationService certifications;

    public CertificationController(CertificationService certifications) {
        this.certifications = certifications;
    }

    public record SubmitRequest(@NotNull UUID agentId, @NotNull JsonNode report) {
    }

    public record RevokeRequest(String reason) {
    }

    public record CertifierRequest(boolean certifier) {
    }

    /** Called by a certifier's agent with the conformance suite's report. */
    @PostMapping("/certifications")
    public Certification submit(@Valid @RequestBody SubmitRequest req) {
        return certifications.submit(Principals.agent(), req.agentId(), req.report());
    }

    /** Certification status is public to every authenticated caller, like discovery. */
    @GetMapping("/agents/{agentId}/certifications")
    public List<Certification> forAgent(@PathVariable UUID agentId) {
        Principals.current();
        return certifications.forAgent(agentId);
    }

    @GetMapping("/certifications/{id}")
    public Certification report(@PathVariable UUID id) {
        return certifications.report(Principals.user(), id);
    }

    @GetMapping("/admin/certifications")
    public List<Certification> latest(@RequestParam(defaultValue = "100") int limit) {
        return certifications.latest(Principals.user(), limit);
    }

    @PostMapping("/admin/certifications/{id}/revoke")
    public Certification revoke(@PathVariable UUID id, @RequestBody RevokeRequest req) {
        return certifications.revoke(Principals.user(), id, req.reason());
    }

    @PutMapping("/admin/organizations/{orgId}/certifier")
    public Map<String, Object> setCertifier(@PathVariable UUID orgId, @RequestBody CertifierRequest req) {
        var org = certifications.setCertifier(Principals.user(), orgId, req.certifier());
        return Map.of("orgId", org.getId(), "certifier", org.isCertifier());
    }
}
