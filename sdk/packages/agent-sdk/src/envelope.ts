import { randomBytes, randomUUID } from "node:crypto";
import { canonicalBytes } from "./jcs.ts";
import { VerificationError } from "./jws.ts";
import { b64url, sha256Hash, signBytes, verifyBytes, type AgentKeyPair } from "./keys.ts";
import { ENVELOPE_VERSION, type Envelope, type EnvelopeHeader, type MessageKind, type Receipt, type SignedReceipt } from "./protocol.ts";

export const DEFAULT_ENVELOPE_TTL_SECONDS = 60;
export const CLOCK_SKEW_SECONDS = 30;

export interface EnvelopeInput<B> {
  from: string;
  to: string;
  kid: string;
  taskId: string;
  capability: string;
  idempotencyKey: string;
  body: B;
  grant?: string;
  inReplyTo?: string;
  kind?: MessageKind;
  round?: number;
  ttlSeconds?: number;
}

function signingInput(header: EnvelopeHeader, body: unknown): Buffer {
  return canonicalBytes({ header, body });
}

export function buildEnvelope<B>(input: EnvelopeInput<B>, keys: AgentKeyPair): Envelope<B> {
  const now = Math.floor(Date.now() / 1000);
  const header: EnvelopeHeader = {
    v: ENVELOPE_VERSION,
    msgId: randomUUID(),
    taskId: input.taskId,
    from: input.from,
    to: input.to,
    kid: input.kid,
    capability: input.capability,
    iat: now,
    exp: now + (input.ttlSeconds ?? DEFAULT_ENVELOPE_TTL_SECONDS),
    nonce: b64url(randomBytes(16)),
    idempotencyKey: input.idempotencyKey,
    ...(input.grant ? { grant: input.grant } : {}),
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.round ? { round: input.round } : {}),
  };
  return { header, body: input.body, signature: signBytes(keys, signingInput(header, input.body)) };
}

/** Checks signature, version and freshness. Addressing, grant and replay checks are the caller's. */
export function verifyEnvelope(envelope: Envelope, publicKey: string, nowSeconds = Math.floor(Date.now() / 1000)): void {
  const h = envelope?.header;
  if (!h || h.v !== ENVELOPE_VERSION || typeof envelope.signature !== "string") {
    throw new VerificationError("Malformed envelope", "malformed");
  }
  if (!verifyBytes(publicKey, signingInput(h, envelope.body), envelope.signature)) {
    throw new VerificationError("Envelope signature does not verify", "bad_signature");
  }
  if (h.exp < nowSeconds || h.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new VerificationError("Envelope expired or not yet valid", "expired");
  }
}

/** Binds a receipt to the exact signed request (header and body). */
export function requestHash(envelope: Envelope): string {
  return sha256Hash(signingInput(envelope.header, envelope.body));
}

export function responseHash(body: unknown): string {
  return sha256Hash(canonicalBytes(body));
}

export function signReceipt(receipt: Receipt, keys: AgentKeyPair): string {
  return signBytes(keys, canonicalBytes(receipt));
}

export function verifyReceiptSignature(receipt: Receipt, publicKey: string, signature: string | undefined): boolean {
  return !!signature && verifyBytes(publicKey, canonicalBytes(receipt), signature);
}

export function countersign(signed: SignedReceipt, kid: string, keys: AgentKeyPair): SignedReceipt {
  return { ...signed, requesterKid: kid, requesterSignature: signReceipt(signed.receipt, keys) };
}
