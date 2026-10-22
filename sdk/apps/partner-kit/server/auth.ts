import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_HOURS = 12;

/**
 * Operator sessions for the node's own UI. One shared operator password per node for now; the
 * node is run by one business, and SSO can replace this without touching the API.
 */
export class OperatorAuth {
  private readonly secret: Buffer;
  private readonly passwordHash: Buffer;
  private readonly failures = new Map<string, number[]>();

  constructor(
    password: string,
    sessionSecret?: string,
    private readonly limits = { maxFailures: 10, windowMs: 15 * 60_000 },
  ) {
    if (password.length < 10) throw new Error("KIT_ADMIN_PASSWORD must be at least 10 characters");
    this.passwordHash = createHash("sha256").update(password).digest();
    this.secret = sessionSecret ? createHash("sha256").update(sessionSecret).digest() : randomBytes(32);
  }

  /**
   * Like login(), but refuses a source (usually an IP address) that has failed too often recently, even
   * with the right password, so the shared password cannot be guessed at speed.
   */
  attempt(source: string, password: string): { token?: string; throttled?: boolean } {
    const now = Date.now();
    const recent = (this.failures.get(source) ?? []).filter((t) => t > now - this.limits.windowMs);
    if (recent.length >= this.limits.maxFailures) {
      this.failures.set(source, recent);
      return { throttled: true };
    }
    const token = this.login(password);
    if (token) {
      this.failures.delete(source);
      return { token };
    }
    if (this.failures.size > 10_000) for (const [k, v] of this.failures) if (!v.some((t) => t > now - this.limits.windowMs)) this.failures.delete(k);
    this.failures.set(source, [...recent, now]);
    return {};
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
