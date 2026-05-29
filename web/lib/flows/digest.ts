import "server-only";

import { createHash } from "node:crypto";

import type { FlowYamlV1 } from "@/lib/config.schema";

// Stable, deterministic JSON serialization: object keys sorted recursively so
// the digest is invariant under key reordering in the source YAML. Arrays keep
// their order (order is semantically meaningful for steps).
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);

  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;

    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize(obj[key]);

        return acc;
      }, {});
  }

  return value;
}

// sha256 of the canonical (sorted-key) JSON of a parsed flow manifest. Used as
// the content-addressed identity for local sources and as the integrity digest
// recorded on every flow_revisions row (see ADR-021).
export function manifestDigest(manifest: FlowYamlV1): string {
  const canonical = JSON.stringify(canonicalize(manifest));

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
