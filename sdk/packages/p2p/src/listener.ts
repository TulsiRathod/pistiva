import type { AgentKeyPair, P2PSession } from "@pistiva/agent-sdk";
import "@pistiva/gateway";
import type { FastifyInstance } from "fastify";
import { RTCPeerConnection, RTCSessionDescription } from "werift";
import { answerSignature, connectionKind, FrameAssembler, gathered, toFrames, toIceServers, trustedKeys, verifiedBy, type Signaling } from "./signaling.ts";

export interface PeerListenerOptions {
  platform: Signaling;
  keys: AgentKeyPair;
  /** The provider gateway; requests from the data channel are injected into it, so every check still runs. */
  app: FastifyInstance;
  /** Pause between polls. The platform holds each poll for up to 20 s when nothing is waiting. */
  pollMs?: number;
  /** How long the platform may hold a poll open; 0 for a plain poll. */
  longPollSeconds?: number;
  forceRelay?: boolean;
  onError?(e: unknown): void;
}

/**
 * The provider side of peer-to-peer: polls the platform for signed offers, answers them, and serves
 * the requester's JSON-RPC messages from the data channel through the local gateway. The gateway
 * learns whether the connection was direct or relayed from here, and records it in its receipts.
 */
export class PeerListener {
  private timer?: NodeJS.Timeout;
  private polling = false;
  private running = false;
  private readonly seen = new Set<string>();
  private readonly connections = new Set<RTCPeerConnection>();

  constructor(private readonly opts: PeerListenerOptions) {}

  start(): void {
    this.running = true;
    void (async () => {
      while (this.running) {
        await this.poll(this.opts.longPollSeconds ?? 20);
        await new Promise<void>((r) => {
          this.timer = setTimeout(r, this.opts.pollMs ?? 200);
          this.timer.unref?.();
        });
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    for (const pc of this.connections) await pc.close().catch(() => undefined);
    this.connections.clear();
  }

  /** Handles every offer waiting for this agent. `start()` calls it on a timer. */
  async poll(waitSeconds = 0): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const session of await this.opts.platform.pendingP2PSessions(waitSeconds)) {
        if (this.seen.has(session.id)) continue;
        this.seen.add(session.id);
        await this.accept(session).catch((e) => this.opts.onError?.(e));
      }
      if (this.seen.size > 1000) this.seen.clear();
    } catch (e) {
      this.opts.onError?.(e);
    } finally {
      this.polling = false;
    }
  }

  private async accept(session: P2PSession): Promise<void> {
    const { platform, keys } = this.opts;
    // Only answer a live key of an active agent in a trusted organization, and only an offer it signed for us.
    const offerPayload = { t: "pistiva-p2p-offer", from: session.requesterAgentId, to: platform.agentId, sdp: session.offer };
    if (session.providerAgentId !== platform.agentId || !verifiedBy(await trustedKeys(platform, session.requesterAgentId), offerPayload, session.offerSignature)) {
      throw new Error(`Ignoring p2p offer ${session.id}: not signed by a trusted requester`);
    }
    const pc = new RTCPeerConnection({ iceServers: toIceServers(await platform.iceServers()), iceTransportPolicy: this.opts.forceRelay ? "relay" : "all" });
    this.connections.add(pc);
    let kind: Promise<"direct" | "relayed"> | undefined;
    pc.onDataChannel.subscribe((channel) => {
      const assembler = new FrameAssembler();
      channel.onMessage.subscribe((data) => {
        const text = assembler.push(data.toString());
        if (text === undefined) return;
        kind ??= connectionKind(pc);
        void this.serve(channel, text, kind);
      });
      channel.stateChanged.subscribe((s) => {
        if (s === "closed") {
          this.connections.delete(pc);
          void pc.close().catch(() => undefined);
        }
      });
    });
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(session.offer, "offer"));
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      const sdp = pc.localDescription!.sdp;
      await platform.answerP2PSession(session.id, sdp, answerSignature(keys, session.id, platform.agentId, session.requesterAgentId, session.offer, sdp));
    } catch (e) {
      this.connections.delete(pc);
      await pc.close().catch(() => undefined);
      throw e;
    }
    // A connection the requester never uses must not linger.
    const abandon = setTimeout(() => {
      if (!kind) {
        this.connections.delete(pc);
        void pc.close().catch(() => undefined);
      }
    }, 30_000);
    abandon.unref?.();
  }

  private async serve(channel: { send(data: string): void }, text: string, kind: Promise<"direct" | "relayed">): Promise<void> {
    let id: string | null = null;
    const reply = (message: string) => {
      for (const frame of toFrames(message)) channel.send(frame);
    };
    try {
      const frame = JSON.parse(text) as { authorization?: string; body: string };
      id = (JSON.parse(frame.body) as { id?: string }).id ?? null;
      const connection = await kind;
      const res = await this.opts.app.handleRpc(JSON.parse(frame.body), frame.authorization, connection);
      reply(JSON.stringify(res));
    } catch {
      reply(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } }));
    }
  }
}
