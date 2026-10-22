package com.pistiva.platform.p2p;

import com.pistiva.platform.security.Principals;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

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

    @GetMapping("/p2p/sessions/pending")
    public List<P2PService.Session> pending() {
        return p2p.pending(Principals.agent());
    }

    @GetMapping("/p2p/sessions/{id}")
    public P2PService.Session get(@PathVariable UUID id) {
        return p2p.get(Principals.agent(), id);
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
