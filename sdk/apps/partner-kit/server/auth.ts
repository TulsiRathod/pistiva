import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_HOURS = 12;

/**
 * Operator sessions for the node's own UI. One shared operator password per node for now; the
 * node is run by one business, and SSO can replace this without touching the API.
 */
export class OperatorAuth {
  private readonly secret: Buffer;
  private readonly passwordHash: Buffer;

  constructor(password: string, sessionSecret?: string) {
    if (password.length < 10) throw new Error("KIT_ADMIN_PASSWORD must be at least 10 characters");
    this.passwordHash = createHash("sha256").update(password).digest();
    this.secret = sessionSecret ? createHash("sha256").update(sessionSecret).digest() : randomBytes(32);
  }

  login(password: string): string | undefined {
    const given = createHash("sha256").update(password ?? "").digest();
    if (!timingSafeEqual(given, this.passwordHash)) return undefined;
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_HOURS * 3600_000 })).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  verify(token: string | undefined): boolean {
    const [payload, sig] = (token ?? "").split(".");
    if (!payload || !sig) return false;
    const expected = Buffer.from(this.sign(payload));
    const actual = Buffer.from(sig);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    try {
      return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).exp > Date.now();
    } catch {
      return false;
    }
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }
}
