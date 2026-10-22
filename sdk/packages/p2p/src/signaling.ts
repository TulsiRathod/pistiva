import { canonicalBytes, signBytes, verifyBytes, type AgentKeyPair, type IceServerConfig, type P2PSession, type PlatformLookup } from "@pistiva/agent-sdk";
import { RTCPeerConnection, type RTCIceServer } from "werift";

/** What the transport and listener need from the platform; `PlatformClient` implements it. */
export interface Signaling extends Pick<PlatformLookup, "agentStatus"> {
  readonly agentId: string;
  readonly kid: string;
  iceServers(): Promise<IceServerConfig[]>;
  createP2PSession(providerAgentId: string, offer: string, signature: string): Promise<P2PSession>;
  pendingP2PSessions(): Promise<P2PSession[]>;
  p2pSession(id: string): Promise<P2PSession>;
  answerP2PSession(id: string, answer: string, signature: string): Promise<P2PSession>;
}

/** The channel label and the message limit both ends agree on. */
export const CHANNEL = "a2a";
export const MAX_MESSAGE_BYTES = 60 * 1024;

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
