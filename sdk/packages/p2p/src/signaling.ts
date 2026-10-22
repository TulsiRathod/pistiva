import { randomUUID } from "node:crypto";
import { canonicalBytes, signBytes, verifyBytes, type AgentKeyPair, type IceServerConfig, type P2PSession, type PlatformLookup } from "@pistiva/agent-sdk";
import { RTCPeerConnection, type RTCIceServer } from "werift";

/** What the transport and listener need from the platform; `PlatformClient` implements it. */
export interface Signaling extends Pick<PlatformLookup, "agentStatus"> {
  readonly agentId: string;
  readonly kid: string;
  iceServers(): Promise<IceServerConfig[]>;
  createP2PSession(providerAgentId: string, offer: string, signature: string): Promise<P2PSession>;
  pendingP2PSessions(waitSeconds?: number): Promise<P2PSession[]>;
  p2pSession(id: string, waitSeconds?: number): Promise<P2PSession>;
  answerP2PSession(id: string, answer: string, signature: string): Promise<P2PSession>;
}

/** The channel label and the message limit both ends agree on. */
export const CHANNEL = "a2a";
/** Largest logical message (a JSON-RPC request or reply); bigger ones are refused, not truncated. */
export const MAX_MESSAGE_CHARS = 4 * 1024 * 1024;
/** A data channel message stays well under the ~64 KB SCTP limit even for multi-byte text. */
const CHUNK_CHARS = 16 * 1024;
const MAX_PARTIAL_MESSAGES = 16;

/** Splits a logical message into frames small enough for one data channel message each. */
export function toFrames(text: string): string[] {
  if (text.length > MAX_MESSAGE_CHARS) throw new Error("Message too large for a peer connection");
  const id = randomUUID();
  const n = Math.max(1, Math.ceil(text.length / CHUNK_CHARS));
  return Array.from({ length: n }, (_, i) => JSON.stringify({ m: id, i, n, d: text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) }));
}

/** Puts frames back together; returns the message when its last frame arrives. Malformed or excess input is dropped. */
export class FrameAssembler {
  private readonly partial = new Map<string, { n: number; parts: Map<number, string> }>();

  push(raw: string): string | undefined {
    let frame: { m?: unknown; i?: unknown; n?: unknown; d?: unknown };
    try {
      frame = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const { m, d } = frame;
    const i = frame.i as number;
    const n = frame.n as number;
    if (typeof m !== "string" || typeof d !== "string" || !Number.isInteger(i) || !Number.isInteger(n) || n < 1 || i < 0 || i >= n) return undefined;
    if (n * CHUNK_CHARS > MAX_MESSAGE_CHARS + CHUNK_CHARS || d.length > CHUNK_CHARS) return undefined;
    let entry = this.partial.get(m);
    if (!entry) {
      if (this.partial.size >= MAX_PARTIAL_MESSAGES) this.partial.delete(this.partial.keys().next().value as string);
      entry = { n, parts: new Map() };
      this.partial.set(m, entry);
    }
    if (entry.n !== n || entry.parts.has(i)) return undefined;
    entry.parts.set(i, d);
    if (entry.parts.size < entry.n) return undefined;
    this.partial.delete(m);
    return Array.from({ length: entry.n }, (_, k) => entry!.parts.get(k)).join("");
  }
}

/**
 * Agents sign what they send through the platform, so it cannot swap in its own DTLS fingerprint:
 * the SDP (which carries the fingerprint) is covered together with who it is from and for.
 */
export function offerSignature(keys: AgentKeyPair, from: string, to: string, sdp: string): string {
  return signBytes(keys, canonicalBytes({ t: "pistiva-p2p-offer", from, to, sdp }));
}

export function answerSignature(keys: AgentKeyPair, sessionId: string, from: string, to: string, offerSdp: string, sdp: string): string {
  return signBytes(keys, canonicalBytes({ t: "pistiva-p2p-answer", sessionId, from, to, offer: offerSdp, sdp }));
}

/** The live public keys of an active agent in a trusted organization; empty otherwise. */
export async function trustedKeys(platform: Pick<PlatformLookup, "agentStatus">, agentId: string): Promise<string[]> {
  const status = await platform.agentStatus(agentId);
  if (status.status !== "ACTIVE" || !status.orgTrusted) return [];
  return status.keys.filter((k) => !k.revoked).map((k) => k.publicKey);
}

export function verifiedBy(publicKeys: string[], payload: object, signature: string): boolean {
  return publicKeys.some((k) => verifyBytes(k, canonicalBytes(payload), signature));
}

export function toIceServers(servers: IceServerConfig[]): RTCIceServer[] {
  return servers.map((s) => ({ urls: s.urls, ...(s.username ? { username: s.username } : {}), ...(s.credential ? { credential: s.credential } : {}) })) as RTCIceServer[];
}

/** Resolves once local ICE gathering is complete, so the SDP carries every candidate (no trickle). */
export function gathered(pc: RTCPeerConnection, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    pc.iceGatheringStateChange.subscribe((s) => {
      if (s === "complete") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

interface StatsEntry {
  id: string;
  type: string;
  selectedCandidatePairId?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
  nominated?: boolean;
  state?: string;
  candidateType?: string;
}

/** "relayed" when the selected candidate pair uses a TURN relay on either side. */
export async function connectionKind(pc: RTCPeerConnection): Promise<"direct" | "relayed"> {
  const stats = [...(await pc.getStats()).values()] as unknown as StatsEntry[];
  const byId = new Map(stats.map((s) => [s.id, s]));
  const selectedId = stats.find((s) => s.type === "transport")?.selectedCandidatePairId;
  const pair = (selectedId && byId.get(selectedId)) || stats.find((s) => s.type === "candidate-pair" && s.nominated && s.state === "succeeded");
  const types = [pair?.localCandidateId, pair?.remoteCandidateId].map((id) => (id ? byId.get(id)?.candidateType : undefined));
  return types.includes("relay") ? "relayed" : "direct";
}
