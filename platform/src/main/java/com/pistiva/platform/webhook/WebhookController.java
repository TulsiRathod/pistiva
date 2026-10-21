package com.pistiva.platform.webhook;

import com.pistiva.platform.security.Principals;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@RestController
public class WebhookController {

    private final WebhookService webhooks;

    public WebhookController(WebhookService webhooks) {
        this.webhooks = webhooks;
    }

    public record CreateWebhookRequest(@NotBlank String url, @NotEmpty List<String> events) {
    }

    /** The response is the only time the signing secret is shown. */
    @PostMapping("/orgs/{orgId}/webhooks")
    public WebhookService.Webhook create(@PathVariable UUID orgId, @Valid @RequestBody CreateWebhookRequest req) {
        return webhooks.create(Principals.user(), orgId, req.url(), req.events());
    }

    @GetMapping("/orgs/{orgId}/webhooks")
    public List<WebhookService.Webhook> list(@PathVariable UUID orgId) {
        return webhooks.list(Principals.user(), orgId);
    }

    @DeleteMapping("/orgs/{orgId}/webhooks/{webhookId}")
    public Map<String, Boolean> delete(@PathVariable UUID orgId, @PathVariable UUID webhookId) {
        webhooks.delete(Principals.user(), orgId, webhookId);
        return Map.of("deleted", true);
    }

    @GetMapping("/orgs/{orgId}/webhooks/{webhookId}/deliveries")
    public List<WebhookService.Delivery> deliveries(@PathVariable UUID orgId, @PathVariable UUID webhookId) {
        return webhooks.deliveries(Principals.user(), orgId, webhookId);
    }

    @GetMapping("/webhooks/event-types")
    public Set<String> eventTypes() {
        return WebhookService.EVENT_TYPES;
    }
}
