import { describe, expect, it } from "vitest";
import { OperatorAuth } from "../server/auth.ts";

describe("operator sign-in", () => {
  it("refuses a source after repeated failures, even with the right password, but not other sources", () => {
    const auth = new OperatorAuth("operator-password", "secret", { maxFailures: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) expect(auth.attempt("1.2.3.4", "wrong")).toEqual({});
    expect(auth.attempt("1.2.3.4", "wrong")).toEqual({ throttled: true });
    expect(auth.attempt("1.2.3.4", "operator-password")).toEqual({ throttled: true });
    expect(auth.verify(auth.attempt("5.6.7.8", "operator-password").token)).toBe(true);
  });

  it("forgets failures after a success and after the window", async () => {
    const auth = new OperatorAuth("operator-password", "secret", { maxFailures: 2, windowMs: 80 });
    auth.attempt("a", "wrong");
    expect(auth.attempt("a", "operator-password").token).toBeDefined();
    auth.attempt("a", "wrong");
    auth.attempt("a", "wrong");
    expect(auth.attempt("a", "operator-password")).toEqual({ throttled: true });
    await new Promise((r) => setTimeout(r, 120));
    expect(auth.attempt("a", "operator-password").token).toBeDefined();
  });
});
