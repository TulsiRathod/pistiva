# ADR 012: Peer-to-peer connections with relay fallback

- Status: Accepted
- Date: 2026-10-22

## Context

Agents reach each other over HTTPS endpoints that every provider must expose publicly. The spec calls for a direct connection between the parties, with a relay only when a direct path is impossible, and for the network to report which one it used. A relay must not become a place where task data can be read.

## Decision

1. **WebRTC data channels carry the same A2A JSON-RPC.** `@pistiva/p2p` (`werift`, pure TypeScript) sets up one DTLS-encrypted data channel per requester–provider pair. The requester's `A2AClient` tries it first through an `RpcTransport`. Any failure (no answer, timeout, oversized message) falls back to the provider's HTTPS endpoint, so a task never fails only because peer-to-peer did.
2. **Nothing changes in what is checked.** The provider's listener hands each message to the gateway's `handleRpc`, the same entry point as the HTTPS route. Signatures, grants, replay, contracts and disclosure rules all run as before.
3. **The platform only signals.** `POST /p2p/sessions` stores an agent-signed offer, the provider polls `GET /p2p/sessions/pending` and answers with `POST /p2p/sessions/{id}/answer`. Sessions are readable only by their two agents and live for 60 seconds.
   - The SDP carries the DTLS fingerprint, so both offer and answer are **signed with the agent's key** over the SDP, the session and both agent ids. Each side verifies the other's signature against its live platform key before connecting. The platform cannot substitute its own fingerprint to sit in the middle.
   - Only active agents of trusted organizations can open or answer sessions, and a requester may open 60 offers a minute.
4. **The relay is a standard TURN server.** The platform returns `GET /p2p/ice-servers`: configured STUN URLs plus TURN credentials in coturn's `use-auth-secret` form (`username = <expiry>:<agentId>`, `credential = base64(HMAC-SHA1(secret, username))`). Credentials last ten minutes and name one agent, so coturn verifies them with no database. TURN forwards only DTLS ciphertext. `infra/turn.yml` adds coturn to the local stack.
5. **The connection kind is reported, and signed.** After the channel opens, each side reads the selected ICE candidate pair; a relay candidate on either side means `relayed`, anything else is `direct`. The provider gateway puts `connection` into the receipt it signs. Because the requester countersigns that receipt and the platform checks both signatures, the figure is on the record of both parties. Plain HTTPS leaves the field out and counts as direct. The connection kind is passed in-process by the listener, so a remote caller cannot claim to be "direct" or "relayed".
6. **Reporting.** The outcome of a task is `relayed` if any round used the relay. Partner Kit metrics count `pistiva_kit_connections_total{connection}`, and the platform copies the receipt's connection to the task's usage record so payouts can show relayed volume.
7. **Opt-in per node.** `p2p: { enabled: true }` in `agents.yaml`. `forceRelay: true` sends everything through TURN, for networks that block direct paths.

## Consequences

- Messages are split into 16K-character frames and reassembled, up to 4 MB per message; anything larger goes over HTTPS. Incomplete messages are bounded (16 at a time) and duplicate or malformed frames are dropped.
- Providers learn about offers by long polling: `GET /p2p/sessions/pending?waitSeconds=20` holds the request until an offer arrives, so an idle provider costs about three requests a minute and an offer is seen immediately. The platform parks no thread for it (`DeferredResult`), allows each agent three open waits and 2000 in total, and re-checks every half second. Requesters wait for the answer the same way.
- Without a TURN server, two agents behind symmetric NATs fall back to HTTPS, which still needs the provider's public endpoint. TURN removes that need only for the data path; signaling already works without any inbound port.
- The relay sees who talks to whom and how much, not what. Operators who want that hidden too can run their own TURN and set `forceRelay`.
