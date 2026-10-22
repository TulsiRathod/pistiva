package com.pistiva.platform.p2p;

import com.pistiva.platform.security.Principals;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.DeferredResult;

import java.util.List;
import java.util.UUID;

/** Agent-only endpoints for setting up WebRTC connections; see {@link P2PService}. */
@RestController
public class P2PController {

    private final P2PService p2p;

    public P2PController(P2PService p2p) {
        this.p2p = p2p;
    }

    public record OfferRequest(UUID providerAgentId, String offer, String signature) {
    }

    public record AnswerRequest(String answer, String signature) {
    }

    @GetMapping("/p2p/ice-servers")
    public P2PService.IceServers iceServers() {
        return p2p.iceServers(Principals.agent());
    }

    @PostMapping("/p2p/sessions")
    public P2PService.Session offer(@RequestBody OfferRequest req) {
        return p2p.offer(Principals.agent(), req.providerAgentId(), req.offer(), req.signature());
    }

    /** With {@code waitSeconds}, holds the request until an offer arrives (or the wait ends with an empty list). */
    @GetMapping("/p2p/sessions/pending")
    public DeferredResult<List<P2PService.Session>> pending(@RequestParam(defaultValue = "0") int waitSeconds) {
        var provider = Principals.agent();
        return p2p.waitFor(provider.agentId(), waitSeconds, () -> {
            var found = p2p.pending(provider);
            return found.isEmpty() ? null : found;
        }, List::of);
    }

    /** With {@code waitSeconds}, holds the request until the provider has answered. */
    @GetMapping("/p2p/sessions/{id}")
    public DeferredResult<P2PService.Session> get(@PathVariable UUID id, @RequestParam(defaultValue = "0") int waitSeconds) {
        var caller = Principals.agent();
        p2p.get(caller, id); // fail fast with 404 for a stranger
        return p2p.waitFor(caller.agentId(), waitSeconds, () -> {
            var s = p2p.get(caller, id);
            return s.answer() == null ? null : s;
        }, () -> p2p.get(caller, id));
    }

    @PostMapping("/p2p/sessions/{id}/answer")
    public P2PService.Session answer(@PathVariable UUID id, @RequestBody AnswerRequest req) {
        return p2p.answer(Principals.agent(), id, req.answer(), req.signature());
    }

    @Scheduled(fixedDelay = 600_000, initialDelay = 600_000)
    public void purge() {
        p2p.purgeExpired();
    }
}
