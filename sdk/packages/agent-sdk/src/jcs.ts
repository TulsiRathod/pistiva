/**
 * RFC 8785 JSON Canonicalization for the subset used in signed documents. Must stay byte-for-byte
 * identical to platform/src/main/java/com/pistiva/platform/common/Jcs.java: non-integer
 * numbers are rejected, so amounts travel as decimal strings.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      // JSON.stringify string escaping is exactly the RFC 8785 escaping.
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new Error("Signed documents may only contain safe integers; use strings for decimals");
      }
      return String(value);
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map(canonicalize).join(",") + "]";
      }
      // Default sort compares UTF-16 code units, as RFC 8785 requires. Undefined members are dropped, as in JSON.
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + canonicalize(v)).join(",") + "}";
    }
    default:
      throw new Error(`Unsupported JSON value of type ${typeof value}`);
  }
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), "utf8");
}
