import { VerificationError, verifyJws } from "./jws.ts";
import { GRANT_TYP, type EnvelopeHeader, type GrantClaims } from "./protocol.ts";

export interface Jwk {
  kty: string;
  crv?: string;
  kid?: string;
  x?: string;
}

export interface Jwks {
  keys: Jwk[];
}

/**
 * Offline grant verification against the platform JWKS. The grant must be addressed to this
 * provider, issued to the envelope's sender, and cover the envelope's task and capability.
 */
export function verifyGrant(
  token: string,
  jwks: Jwks,
  expected: { issuer: string; header: EnvelopeHeader },
  nowSeconds = Math.floor(Date.now() / 1000),
): GrantClaims {
  const { payload } = verifyJws<GrantClaims>(
    token,
    GRANT_TYP,
    (h) => jwks.keys.find((k) => k.kid === h.kid && k.kty === "OKP" && k.crv === "Ed25519")?.x,
    nowSeconds,
  );
  const { header } = expected;
  if (payload.iss !== expected.issuer) throw new VerificationError("Grant has wrong issuer", "grant_mismatch");
  if (payload.aud !== header.to) throw new VerificationError("Grant is addressed to another provider", "grant_mismatch");
  if (payload.sub !== header.from) throw new VerificationError("Grant was issued to another requester", "grant_mismatch");
  if (payload.tid !== header.taskId) throw new VerificationError("Grant is for another task", "grant_mismatch");
  if (payload.cap !== header.capability) throw new VerificationError("Grant does not cover this capability", "out_of_scope");
  return payload;
}
