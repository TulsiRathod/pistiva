import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  generateKeyPair,
  kidFor,
  loadKeyFile,
  saveKeyFile,
  signBytes,
  signJws,
  verifyBytes,
  verifyJws,
} from "../src/index.ts";

describe("canonical JSON", () => {
  // Same vector as platform CryptoTest.jcsMatchesSharedVector, so both sides sign identical bytes.
  it("matches the shared Java vector", () => {
    const input = JSON.parse('{"b":[3,true,null,"x"],"a":{"z":"\\u0001é","y":10.0},"amount":"12.50"}');
    expect(canonicalize(input)).toBe('{"a":{"y":10,"z":"\\u0001é"},"amount":"12.50","b":[3,true,null,"x"]}');
  });

  it("rejects fractional numbers", () => {
    expect(() => canonicalize({ price: 12.5 })).toThrow();
  });
});

describe("ed25519 keys", () => {
  // RFC 8032 section 7.1 test 1; the platform's CryptoTest checks the same values.
  it("matches RFC 8032 and the platform key id", () => {
    const keys = { publicKey: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", seed: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A" };
    expect(signBytes(keys, Buffer.alloc(0))).toBe("5VZDAMNgrHKQhuLMgG6CioSHfx645dl02HPgZSJJAVVfuIIVkKM7rMYeOXAc-bRr0lv18FlbviRlUUFDjnoQCw");
    expect(kidFor(keys.publicKey)).toBe("48rNXC2TEpWmT2w7s_bqWM");
  });

  it("detects tampering", () => {
    const keys = generateKeyPair();
    const sig = signBytes(keys, Buffer.from("hello"));
    expect(verifyBytes(keys.publicKey, Buffer.from("hello"), sig)).toBe(true);
    expect(verifyBytes(keys.publicKey, Buffer.from("hellO"), sig)).toBe(false);
    expect(verifyBytes(generateKeyPair().publicKey, Buffer.from("hello"), sig)).toBe(false);
  });

  it("round-trips the encrypted key file and refuses a wrong passphrase", async () => {
    const keys = generateKeyPair();
    const path = join(await mkdtemp(join(tmpdir(), "pistiva-keys-")), "agent.key.json");
    await saveKeyFile(path, keys, "correct passphrase");
    expect(await loadKeyFile(path, "correct passphrase")).toEqual(keys);
    await expect(loadKeyFile(path, "wrong passphrase")).rejects.toThrow();
  });
});

describe("jws", () => {
  it("verifies, and rejects wrong type, wrong key and expiry", () => {
    const keys = generateKeyPair();
    const now = Math.floor(Date.now() / 1000);
    const token = signJws("test+jwt", "k1", { sub: "a", exp: now + 60 }, keys);
    expect(verifyJws(token, "test+jwt", () => keys.publicKey).payload.sub).toBe("a");
    expect(() => verifyJws(token, "other+jwt", () => keys.publicKey)).toThrow("Unexpected token type");
    expect(() => verifyJws(token, "test+jwt", () => generateKeyPair().publicKey)).toThrow("Bad signature");
    expect(() => verifyJws(token, "test+jwt", () => undefined)).toThrow("Unknown or revoked key");
    const expired = signJws("test+jwt", "k1", { exp: now - 1 }, keys);
    expect(() => verifyJws(expired, "test+jwt", () => keys.publicKey)).toThrow("Token expired");
  });
});
