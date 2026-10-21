package com.pistiva.platform.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.pistiva.platform.agent.AgentService.AgentStatus;
import com.pistiva.platform.agent.AgentService.KeyView;
import com.pistiva.platform.common.ApiException;
import com.pistiva.platform.security.Principals;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

@RestController
public class AgentController {

    private final AgentService agentService;
    private final AgentCardRepository cards;

    public AgentController(AgentService agentService, AgentCardRepository cards) {
        this.agentService = agentService;
        this.cards = cards;
    }

    public record CreateAgentRequest(@NotNull UUID orgId, @NotBlank @Size(max = 200) String name,
                                     @NotBlank @Size(max = 50) String version, @NotBlank String endpointUrl) {
    }

    public record AgentView(UUID id, UUID orgId, String name, String version, String endpointUrl, String status,
                            Instant createdAt) {
        static AgentView of(Agent a) {
            return new AgentView(a.getId(), a.getOrgId(), a.getName(), a.getVersion(), a.getEndpointUrl(),
                    a.getStatus().name(), a.getCreatedAt());
        }
    }

    public record AddKeyRequest(@NotBlank String publicKey) {
    }

    public record StatusRequest(@NotNull Agent.Status status) {
    }

    public record PublishCardRequest(@NotNull JsonNode card, @NotBlank String kid, @NotBlank String signature) {
    }

    public record CardView(UUID agentId, String card, String kid, String signature, Instant publishedAt) {
    }

    @PostMapping("/agents")
    public AgentView create(@Valid @RequestBody CreateAgentRequest req) {
        return AgentView.of(agentService.create(Principals.user(), req.orgId(), req.name(), req.version(), req.endpointUrl()));
    }

    @GetMapping("/agents")
    public List<AgentView> list(@RequestParam UUID orgId) {
        return agentService.list(Principals.user(), orgId).stream().map(AgentView::of).toList();
    }

    @GetMapping("/agents/{id}/keys")
    public List<KeyView> keys(@PathVariable UUID id) {
        return agentService.listKeys(Principals.user(), id).stream().map(KeyView::of).toList();
    }

    @PostMapping("/agents/{id}/keys")
    public KeyView addKey(@PathVariable UUID id, @Valid @RequestBody AddKeyRequest req) {
        return KeyView.of(agentService.addKey(Principals.user(), id, req.publicKey()));
    }

    @DeleteMapping("/agents/{id}/keys/{kid}")
    public KeyView revokeKey(@PathVariable UUID id, @PathVariable String kid) {
        return KeyView.of(agentService.revokeKey(Principals.user(), id, kid));
    }

    @PostMapping("/agents/{id}/status")
    public AgentView setStatus(@PathVariable UUID id, @Valid @RequestBody StatusRequest req) {
        return AgentView.of(agentService.setStatus(Principals.user(), id, req.status()));
    }

    @PutMapping("/agents/{id}/card")
    public CardView publishCard(@PathVariable UUID id, @Valid @RequestBody PublishCardRequest req) {
        AgentCard c = agentService.publishCard(Principals.current(), id, req.card(), req.kid(), req.signature());
        return new CardView(c.getAgentId(), c.getCardJson(), c.getKid(), c.getSignature(), c.getPublishedAt());
    }

    @GetMapping("/agents/{id}/card")
    public CardView card(@PathVariable UUID id) {
        AgentCard c = cards.findById(id).orElseThrow(() -> new ApiException.NotFound("No card published"));
        return new CardView(c.getAgentId(), c.getCardJson(), c.getKid(), c.getSignature(), c.getPublishedAt());
    }

    /** Used by gateways to check a peer's status and keys before trusting its messages. */
    @GetMapping("/agents/{id}/status")
    public AgentStatus status(@PathVariable UUID id) {
        Principals.current();
        return agentService.status(id);
    }
}
