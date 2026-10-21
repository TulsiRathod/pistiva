/** Exact decimal amounts in minor units (paise, cents). Amounts are never floats in this protocol. */

export function toMinor(amount: string): bigint {
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) throw new Error(`Invalid amount: ${amount}`);
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole!) * 100n + BigInt(frac.padEnd(2, "0"));
}

export function fromMinor(minor: bigint): string {
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, "0")}`;
}

/** Scales an amount by a factor in basis points (10000 = 1x), rounding half up. */
export function scaleBps(amount: string, factorBps: number): string {
  return fromMinor((toMinor(amount) * BigInt(factorBps) + 5000n) / 10000n);
}
