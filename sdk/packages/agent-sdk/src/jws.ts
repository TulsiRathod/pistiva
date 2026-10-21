import { b64url, fromB64url, signBytes, verifyBytes, type AgentKeyPair } from "./keys.ts";

export interface JwsHeader {
  alg: "EdDSA";
  typ: string;
  kid: string;
}

export class VerificationError extends Error {
  constructor(
    message: string,
    readonly code: string = "verification_failed",
  ) {
    super(message);
    this.name = "VerificationError";
  }
}

export function signJws(typ: string, kid: string, payload: Record<string, unknown>, keys: AgentKeyPair): string {
  const header: JwsHeader = { alg: "EdDSA", typ, kid };
  const input = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  return `${input}.${signBytes(keys, Buffer.from(input, "ascii"))}`;
}

/**
 * Verifies an EdDSA compact JWS. The resolver returns the raw public key for the header's kid,
 * or undefined when the key is unknown or revoked.
 */
export function verifyJws<T extends Record<string, unknown>>(
  token: string,
  expectedTyp: string,
  resolveKey: (header: JwsHeader) => string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): { header: JwsHeader; payload: T } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new VerificationError("Malformed token");
  let header: JwsHeader;
  let payload: T;
  try {
    header = JSON.parse(fromB64url(parts[0]!).toString("utf8"));
    payload = JSON.parse(fromB64url(parts[1]!).toString("utf8"));
  } catch {
    throw new VerificationError("Malformed token");
  }
  if (header.alg !== "EdDSA" || header.typ !== expectedTyp) {
    throw new VerificationError("Unexpected token type");
  }
  const key = resolveKey(header);
  if (!key) throw new VerificationError("Unknown or revoked key", "unknown_key");
  if (!verifyBytes(key, Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"), parts[2]!)) {
    throw new VerificationError("Bad signature", "bad_signature");
  }
  if (typeof payload.exp !== "number" || payload.exp < nowSeconds) {
    throw new VerificationError("Token expired", "expired");
  }
  return { header, payload };
}
