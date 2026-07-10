import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Idempotency payload numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  if (value === undefined) return "null";
  throw new Error("Idempotency payload contains an unsupported value");
}

export function requestFingerprint(scope: string, payload: unknown): string {
  return createHash("sha256")
    .update(scope)
    .update("\0")
    .update(canonicalJson(payload))
    .digest("hex");
}

export const idempotencyInternals = { canonicalJson };
