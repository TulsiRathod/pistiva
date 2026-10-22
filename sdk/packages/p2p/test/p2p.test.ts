import { createHmac, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { A2AClient, type AgentCard, type DiscoveredAgent, type IceServerConfig, type P2PSession } from "@pistiva/agent-sdk";
import { createProviderGateway } from "@pistiva/gateway";
import type { FastifyInstance } from "fastify";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakePlatform, type FakeAgent } from "../../gateway/test/fake-platform.ts";
import { PeerListener, PeerTransport, type Signaling } from "../src/index.ts";

const SECRET = "test-turn-secret";
const RELAY_PORTS = Array.from({ length: 11 }, (_, i) => 49160 + i);
const QUOTE = { sku: "BOLT-M8-50", available: true, qty: 10, uom: "EA", unitPrice: "4.20", currency: "INR", validUntil: "2026-11-01", terms: "Net 30" };

/** The platform's signaling endpoints in memory: it stores and forwards opaque, agent-signed SDP. */
class InMemorySignaling {
  readonly sessions = new Map<string, P2PSession>();
  constructor(private readonly iceServers: () => IceServerConfig[]) {}

  as(platform: FakePlatform, agent: FakeAgent): Signaling {
    return {
      agentId: agent.agentId,
      kid: agent.kid,
      agentStatus: (id) => platform.agentStatus(id),
      iceServers: async () => this.iceServers(),
      createP2PSession: async (providerAgentId, offer, offerSignature) => {
        const s: P2PSession = { id: randomUUID(), requesterAgentId: agent.agentId, providerAgentId, offer, offerSignature, answer: null, answerSignature: null, expiresAt: "" };
        this.sessions.set(s.id, s);
        return structuredClone(s);
      },
      pendingP2PSessions: async () => [...this.sessions.values()].filter((s) => s.providerAgentId === agent.agentId && !s.answer).map((s) => structuredClone(s)),
      p2pSession: async (id) => structuredClone(this.sessions.get(id)!),
      answerP2PSession: async (id, answer, answerSignature) => {
        const s = this.sessions.get(id)!;
        Object.assign(s, { answer, answerSignature });
        return structuredClone(s);
      },
    };
  }
}

describe("peer-to-peer A2A", { timeout: 120_000 }, () => {
  let coturn: StartedTestContainer;
  let platform: FakePlatform;
  let buyer: FakeAgent;
  let supplier: FakeAgent;
  let app: FastifyInstance;
  let provider: DiscoveredAgent;
  let signaling: InMemorySignaling;
  let useTurn = false;
  const closers: (() => Promise<unknown>)[] = [];

  /** coturn's use-auth-secret scheme, as the platform issues it. */
  const turnServer = (agentId: string): IceServerConfig => {
    const username = `${Math.floor(Date.now() / 1000) + 600}:${agentId}`;
    return { urls: "turn:127.0.0.1:3478?transport=udp", username, credential: createHmac("sha1", SECRET).update(username).digest("base64") };
  };

  beforeAll(async () => {
    coturn = await new GenericContainer("coturn/coturn:4.6.2")
      .withExposedPorts({ container: 3478, host: 3478, protocol: "udp" }, ...RELAY_PORTS.map((p) => ({ container: p, host: p, protocol: "udp" as const })))
      .withCommand(["-n", "--log-file=stdout", "--min-port=49160", "--max-port=49170", "--external-ip=127.0.0.1", "--realm=pistiva", "--use-auth-secret", `--static-auth-secret=${SECRET}`, "--fingerprint", "--no-tls", "--no-dtls", "--allow-loopback-peers", "--no-cli"])
      .withWaitStrategy(Wait.forLogMessage(/Default realm/))
      .start();
    // The realm line is logged just before the UDP listeners open.
    await new Promise((r) => setTimeout(r, 2000));

    platform = new FakePlatform();
    buyer = platform.registerAgent();
    supplier = platform.registerAgent();
    signaling = new InMemorySignaling(() => (useTurn ? [turnServer(buyer.agentId)] : []));
    // Unreachable on purpose: if a request fell back to HTTPS the quote would fail.
    const card: AgentCard = {
      agentId: supplier.agentId,
      orgId: supplier.orgId,
      kid: supplier.kid,
      name: "Supplier",
      version: "1.0.0",
      endpoint: "http://127.0.0.1:1",
      protocols: ["a2a/0.3"],
      capabilities: [{ name: "quote.request", version: 1, description: "Quotes" }],
      issuedAt: 1,
    };
    app = createProviderGateway({
      agentId: supplier.agentId,
      kid: supplier.kid,
      keys: supplier.keys,
      platform,
      card,
      capabilities: { "quote.request": { handle: () => ({ ...QUOTE, costPrice: "2.65" }) } },
    });
    await app.ready();
    provider = { agentId: supplier.agentId, orgId: supplier.orgId, orgName: "Supplier", kid: supplier.kid, publicKey: supplier.keys.publicKey, card } as unknown as DiscoveredAgent;
  }, 180_000);

  afterAll(async () => {
    for (const close of closers) await close().catch(() => undefined);
    await app?.close();
    await coturn?.stop();
  }, 60_000);

  async function run(opts: { forceRelay: boolean }) {
    // Fresh signaling per run, so a listener left over from another test cannot answer this offer.
    signaling = new InMemorySignaling(() => (useTurn ? [turnServer(buyer.agentId)] : []));
    const listener = new PeerListener({ platform: signaling.as(platform, supplier), keys: supplier.keys, app, pollMs: 100, forceRelay: opts.forceRelay });
    listener.start();
    const transport = new PeerTransport({ platform: signaling.as(platform, buyer), keys: buyer.keys, forceRelay: opts.forceRelay, connectTimeoutMs: 20_000 });
    closers.push(() => listener.stop(), () => transport.close());
    const client = new A2AClient({ platform: platform.clientFor(buyer, supplier, ["sku", "available", "unitPrice", "currency"]), keys: buyer.keys, transport });
    const out = await client.run(provider, "quote.request", { sku: "BOLT-M8-50", qty: 10 }, { budget: "100.00", currency: "INR" });
    return { out, transport, listener };
  }

  it("carries a task over a direct WebRTC connection and records it as direct", async () => {
    useTurn = false;
    const { out } = await run({ forceRelay: false });
    expect(out.state).toBe("completed");
    expect(out.result).toEqual({ sku: "BOLT-M8-50", available: true, unitPrice: "4.20", currency: "INR" });
    expect(out.connection).toBe("direct");
    expect(out.rounds[0]!.receipt.receipt.connection).toBe("direct");
    // Both ends signed the receipt including how they were connected.
    expect(platform.receipts.at(-1)!.receipt.connection).toBe("direct");
  });

  it("falls back to the TURN relay and records the task as relayed", async () => {
    useTurn = true;
    const { out } = await run({ forceRelay: true });
    expect(out.state).toBe("completed");
    expect(out.connection).toBe("relayed");
    expect(out.rounds[0]!.receipt.receipt.connection).toBe("relayed");
  });

  it("does not answer an offer that its claimed requester did not sign", async () => {
    useTurn = false;
    const errors: unknown[] = [];
    const forged = new InMemorySignaling(() => []);
    forged.sessions.set("s1", { id: "s1", requesterAgentId: buyer.agentId, providerAgentId: supplier.agentId, offer: "v=0 forged", offerSignature: "bm90LWEtc2lnbmF0dXJl", answer: null, answerSignature: null, expiresAt: "" });
    const listener = new PeerListener({ platform: forged.as(platform, supplier), keys: supplier.keys, app, onError: (e) => errors.push(e) });
    await listener.poll();
    expect(String(errors[0])).toContain("not signed by a trusted requester");
    expect(forged.sessions.get("s1")!.answer).toBeNull();
  });

  it("falls back to HTTPS when no peer answers, and the receipt carries no peer connection", async () => {
    useTurn = false;
    // A signaling service nobody listens on: the transport gives up and the same request goes over HTTPS.
    const silent = new InMemorySignaling(() => []);
    const deaf = new PeerTransport({ platform: silent.as(platform, buyer), keys: buyer.keys, connectTimeoutMs: 600 });
    closers.push(() => deaf.close());
    await app.listen({ port: 0, host: "127.0.0.1" });
    const endpoint = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const reachable = { ...provider, card: { ...provider.card, endpoint } } as DiscoveredAgent;
    const client = new A2AClient({ platform: platform.clientFor(buyer, supplier, []), keys: buyer.keys, transport: deaf });
    const out = await client.run(reachable, "quote.request", { sku: "X", qty: 1 }, { budget: "1.00", currency: "INR" });
    expect(out.state).toBe("completed");
    expect(out.connection).toBe("direct");
    expect(out.rounds[0]!.receipt.receipt.connection).toBeUndefined();
  });
});
