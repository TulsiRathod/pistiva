import type { AgentKeyPair, ConnectionKind, DiscoveredAgent, RpcTransport } from "@pistiva/agent-sdk";
import { RTCPeerConnection, RTCSessionDescription, type RTCDataChannel } from "werift";
import { CHANNEL, connectionKind, FrameAssembler, gathered, offerSignature, toFrames, toIceServers, trustedKeys, verifiedBy, type Signaling } from "./signaling.ts";

export interface PeerTransportOptions {
  platform: Signaling;
  keys: AgentKeyPair;
  /** How long to wait for the provider to answer and the channel to open before falling back to HTTPS. */
  connectTimeoutMs?: number;
  /** Idle channels are closed after this long. */
  idleMs?: number;
  /** Use only TURN (for networks that block direct paths, and for tests). */
  forceRelay?: boolean;
}

interface Peer {
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
  connection: ConnectionKind;
  pending: Map<string, { resolve(text: string): void; reject(e: Error): void }>;
  idle?: NodeJS.Timeout;
}

/**
 * Sends A2A JSON-RPC over a WebRTC data channel to the provider, setting the connection up through the
 * platform's signaling. The traffic is DTLS-encrypted between the two agents: the platform never sees
 * it, and neither does a TURN relay, which only forwards ciphertext. Any failure resolves undefined so
 * the A2A client falls back to HTTPS.
 */
export class PeerTransport implements RpcTransport {
  private readonly peers = new Map<string, Promise<Peer>>();

  constructor(private readonly opts: PeerTransportOptions) {}

  async send(provider: DiscoveredAgent, request: { body: string; authorization?: string }) {
    let frames: string[];
    try {
      frames = toFrames(JSON.stringify({ authorization: request.authorization, body: request.body }));
    } catch {
      return undefined;
    }
    let peer: Peer;
    try {
      peer = await this.peerFor(provider);
    } catch {
      this.peers.delete(provider.agentId);
      return undefined;
    }
    const id = (JSON.parse(request.body) as { id: string }).id;
    const text = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        peer.pending.delete(id);
        reject(new Error("Peer did not reply"));
      }, 30_000);
      peer.pending.set(id, {
        resolve: (t) => {
          clearTimeout(timer);
          resolve(t);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        for (const frame of frames) peer.channel.send(frame);
      } catch (e) {
        clearTimeout(timer);
        peer.pending.delete(id);
        reject(e as Error);
      }
    }).catch(() => undefined);
    this.touch(provider.agentId, peer);
    return text === undefined ? undefined : { text, connection: peer.connection };
  }

  async close(): Promise<void> {
    const peers = await Promise.allSettled([...this.peers.values()]);
    this.peers.clear();
    for (const p of peers) if (p.status === "fulfilled") await this.drop(p.value);
  }

  private peerFor(provider: DiscoveredAgent): Promise<Peer> {
    let peer = this.peers.get(provider.agentId);
    if (!peer) {
      peer = this.connect(provider);
      this.peers.set(provider.agentId, peer);
      peer.catch(() => this.peers.delete(provider.agentId));
    }
    return peer;
  }

  private touch(agentId: string, peer: Peer): void {
    clearTimeout(peer.idle);
    peer.idle = setTimeout(() => {
      this.peers.delete(agentId);
      void this.drop(peer);
    }, this.opts.idleMs ?? 60_000);
    peer.idle.unref?.();
  }

  private async drop(peer: Peer): Promise<void> {
    clearTimeout(peer.idle);
    for (const p of peer.pending.values()) p.reject(new Error("Connection closed"));
    peer.pending.clear();
    await peer.pc.close().catch(() => undefined);
  }

  private async connect(provider: DiscoveredAgent): Promise<Peer> {
    const { platform, keys } = this.opts;
    const deadline = Date.now() + (this.opts.connectTimeoutMs ?? 12_000);
    const pc = new RTCPeerConnection({ iceServers: toIceServers(await platform.iceServers()), iceTransportPolicy: this.opts.forceRelay ? "relay" : "all" });
    try {
      const channel = pc.createDataChannel(CHANNEL);
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      const offer = pc.localDescription!.sdp;
      const session = await platform.createP2PSession(provider.agentId, offer, offerSignature(keys, platform.agentId, provider.agentId, offer));

      // The provider polls for offers; wait for its signed answer.
      let answer = session;
      while (!answer.answer && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
        answer = await platform.p2pSession(session.id, 5);
      }
      if (!answer.answer || !answer.answerSignature) throw new Error("Provider did not answer");
      const payload = { t: "pistiva-p2p-answer", sessionId: session.id, from: provider.agentId, to: platform.agentId, offer, sdp: answer.answer };
      if (!verifiedBy(await trustedKeys(platform, provider.agentId), payload, answer.answerSignature)) {
        throw new Error("Answer is not signed by the provider");
      }
      await pc.setRemoteDescription(new RTCSessionDescription(answer.answer, "answer"));

      await new Promise<void>((resolve, reject) => {
        if (channel.readyState === "open") return resolve();
        const timer = setTimeout(() => reject(new Error("Data channel did not open")), Math.max(1000, deadline - Date.now()));
        channel.stateChanged.subscribe((s) => {
          if (s === "open") {
            clearTimeout(timer);
            resolve();
          }
          if (s === "closed") {
            clearTimeout(timer);
            reject(new Error("Data channel closed"));
          }
        });
      });
      const peer: Peer = { pc, channel, connection: await connectionKind(pc), pending: new Map() };
      const assembler = new FrameAssembler();
      channel.onMessage.subscribe((data) => {
        const text = assembler.push(data.toString());
        if (text === undefined) return;
        let id: unknown;
        try {
          id = (JSON.parse(text) as { id?: unknown }).id;
        } catch {
          return;
        }
        if (typeof id !== "string") return;
        const waiting = peer.pending.get(id);
        if (waiting) {
          peer.pending.delete(id);
          waiting.resolve(text);
        }
      });
      channel.stateChanged.subscribe((s) => {
        if (s === "closed") {
          this.peers.delete(provider.agentId);
          void this.drop(peer);
        }
      });
      this.touch(provider.agentId, peer);
      return peer;
    } catch (e) {
      await pc.close().catch(() => undefined);
      throw e;
    }
  }
}
