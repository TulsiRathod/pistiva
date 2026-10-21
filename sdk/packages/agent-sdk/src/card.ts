import { canonicalBytes } from "./jcs.ts";
import { signBytes, verifyBytes, type AgentKeyPair } from "./keys.ts";
import type { AgentCard, DiscoveredAgent } from "./protocol.ts";

export function signCard(card: AgentCard, keys: AgentKeyPair): string {
  return signBytes(keys, canonicalBytes(card));
}

/**
 * Re-verifies a discovery result locally instead of trusting the registry: the card must be
 * signed by the listed key and describe the agent it was returned for.
 */
export function verifyDiscoveredCard(found: DiscoveredAgent): boolean {
  return (
    found.card.agentId === found.agentId &&
    found.card.orgId === found.orgId &&
    found.card.kid === found.kid &&
    verifyBytes(found.publicKey, canonicalBytes(found.card), found.signature)
  );
}
