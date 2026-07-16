import { createHash } from "node:crypto";

// Shared deterministic content-digest helpers for the Evaluation Lab domain.
// Stable key ordering so the same logical value always digests identically
// regardless of object key order (recipe definitions, method definitions,
// evidence manifests).

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

  return `{${entries.join(",")}}`;
}

// Digest of an arbitrary JSON-serializable value under stable key ordering.
export function contentDigest(value: unknown): string {
  return sha256(stableStringify(value));
}
