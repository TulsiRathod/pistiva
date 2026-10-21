import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Ed25519 key material as base64url raw bytes (the JWK "x" and "d" members). */
export interface AgentKeyPair {
  publicKey: string;
  seed: string;
}

export function b64url(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

export function fromB64url(data: string): Buffer {
  return Buffer.from(data, "base64url");
}

export function generateKeyPair(): AgentKeyPair {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  return { publicKey: jwk.x!, seed: jwk.d! };
}

/** Same derivation as the platform's KeyIds.thumbprint, so both sides agree on the kid. */
export function kidFor(publicKey: string): string {
  return b64url(createHash("sha256").update(publicKey, "ascii").digest()).slice(0, 22);
}

function privateKeyObject(keys: AgentKeyPair): KeyObject {
  return createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: keys.publicKey, d: keys.seed }, format: "jwk" });
}

export function publicKeyObject(publicKey: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
}

export function signBytes(keys: AgentKeyPair, data: Uint8Array): string {
  return b64url(nodeSign(null, data, privateKeyObject(keys)));
}

export function verifyBytes(publicKey: string, data: Uint8Array, signature: string): boolean {
  try {
    return nodeVerify(null, data, publicKeyObject(publicKey), fromB64url(signature));
  } catch {
    return false;
  }
}

/**
 * Development key storage: the seed is encrypted with AES-256-GCM under a scrypt-derived key.
 * Production gateways should keep keys in a KMS/HSM or the OS keystore instead.
 */
export async function saveKeyFile(path: string, keys: AgentKeyPair, passphrase: string): Promise<void> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(passphrase, salt, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(keys.seed, "utf8"), cipher.final()]);
  const file = {
    v: 1,
    publicKey: keys.publicKey,
    kid: kidFor(keys.publicKey),
    salt: b64url(salt),
    iv: b64url(iv),
    tag: b64url(cipher.getAuthTag()),
    ciphertext: b64url(ciphertext),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2), { mode: 0o600 });
}

export async function loadKeyFile(path: string, passphrase: string): Promise<AgentKeyPair> {
  const file = JSON.parse(await readFile(path, "utf8"));
  const decipher = createDecipheriv("aes-256-gcm", scryptSync(passphrase, fromB64url(file.salt), 32), fromB64url(file.iv));
  decipher.setAuthTag(fromB64url(file.tag));
  const seed = Buffer.concat([decipher.update(fromB64url(file.ciphertext)), decipher.final()]).toString("utf8");
  return { publicKey: file.publicKey, seed };
}

export function sha256Hash(data: Uint8Array | string): string {
  return "sha256-" + b64url(createHash("sha256").update(data).digest());
}
