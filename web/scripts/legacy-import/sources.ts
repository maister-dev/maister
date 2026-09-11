import { createHash } from "node:crypto";

// D9 "Inventory and deterministic mapping". Every entry discovered under a
// legacy run directory maps to exactly one preservation lane. `copy` sources
// become host objects through the authorized import path; `manager_authoritative`
// sources are accounted for and left where the manager already owns them —
// manager-authored state does not move to host objects just because it is JSON.
// Anything unrecognized blocks: there is no blanket allowlist.

export const LEGACY_MANIFEST_VERSION = "maister.legacy-import.manifest.v1";

export type LegacyLane =
  | "events"
  | "transcript"
  | "cost"
  | "runtime_objects"
  | "scratch_session";

export const LEGACY_LANES: readonly LegacyLane[] = [
  "events",
  "transcript",
  "cost",
  "runtime_objects",
  "scratch_session",
];

export type LegacySourceClass =
  | "raw_transcript"
  | "cost_diagnostic"
  | "manager_owned"
  | "step_log"
  | "upload"
  | "session_metadata"
  | "unclassified";

export type LegacySourceClassification =
  | {
      sourceClass: "raw_transcript";
      lane: "transcript";
      disposition: "copy";
    }
  | { sourceClass: "cost_diagnostic"; lane: "cost"; disposition: "copy" }
  | {
      sourceClass: "manager_owned";
      lane: "events";
      disposition: "manager_authoritative";
    }
  | { sourceClass: "step_log"; lane: "runtime_objects"; disposition: "copy" }
  | {
      sourceClass: "upload";
      lane: "scratch_session";
      disposition: "copy";
      scope: string;
      fileName: string;
    }
  | {
      sourceClass: "session_metadata";
      lane: "scratch_session";
      disposition: "copy";
    }
  | {
      sourceClass: "unclassified";
      lane: null;
      disposition: "blocked";
      reason: "unclassified_source";
    };

const MANAGER_OWNED_EXACT = new Set([
  "run.json",
  "needs-input.json",
  "flow-assistant-actions.jsonl",
]);
const MANAGER_OWNED_PATTERNS = [
  /^input-[A-Za-z0-9._-]+\.json$/,
  /^node-start-[A-Za-z0-9._-]+\.json$/,
  /^output-[A-Za-z0-9._-]+\.json$/,
];
// No current main producer writes these two, so they are preserved when found
// and never fabricated as expected sources.
const SESSION_METADATA = /^(session|checkpoint[A-Za-z0-9._-]*)\.json$/;

const UNCLASSIFIED: LegacySourceClassification = {
  sourceClass: "unclassified",
  lane: null,
  disposition: "blocked",
  reason: "unclassified_source",
};

// Relative paths inside a run directory are addressed with "/" everywhere so
// one identity digest describes a source regardless of who assembled the path.
export function relativePathDigest(relativePath: string): string {
  return createHash("sha256")
    .update(`${LEGACY_MANIFEST_VERSION}\npath\n${relativePath}`, "utf8")
    .digest("hex");
}

export function classifyLegacySource(
  relativePath: string,
): LegacySourceClassification {
  const segments = relativePath.split("/");
  const name = segments[segments.length - 1];

  if (segments[0] === "uploads") {
    return segments.length === 3
      ? {
          sourceClass: "upload",
          lane: "scratch_session",
          disposition: "copy",
          scope: segments[1],
          fileName: name,
        }
      : UNCLASSIFIED;
  }

  if (segments.length === 1) {
    if (name === "run.events.jsonl")
      return {
        sourceClass: "raw_transcript",
        lane: "transcript",
        disposition: "copy",
      };
    if (name === "cost.jsonl")
      return { sourceClass: "cost_diagnostic", lane: "cost", disposition: "copy" };
    if (
      MANAGER_OWNED_EXACT.has(name) ||
      MANAGER_OWNED_PATTERNS.some((pattern) => pattern.test(name))
    )
      return {
        sourceClass: "manager_owned",
        lane: "events",
        disposition: "manager_authoritative",
      };
    if (SESSION_METADATA.test(name))
      return {
        sourceClass: "session_metadata",
        lane: "scratch_session",
        disposition: "copy",
      };
  }

  if (name.endsWith(".log"))
    return { sourceClass: "step_log", lane: "runtime_objects", disposition: "copy" };

  return UNCLASSIFIED;
}

// D9: "a deterministic digest of manifest version, frozen source identity,
// run/association identity, relative-path identity digest, byte size and
// SHA-256". Duplicate references to one file share bytes and keep distinct
// logical identities because the association key participates.
export function manifestItemId(input: {
  manifestVersion: string;
  frozenSourceId: string;
  runId: string;
  associationKey: string;
  relativePathDigest: string;
  size: number;
  sha256: string;
}): string {
  return createHash("sha256")
    .update(
      [
        input.manifestVersion,
        input.frozenSourceId,
        input.runId,
        input.associationKey,
        input.relativePathDigest,
        String(input.size),
        input.sha256,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
}

// The lane's `source_fingerprint`. `inspectedScope` is what makes an empty lane
// a proof: it binds the zero to the directory listing that was actually walked,
// so a lane that was never inspected cannot report the same digest as one that
// was inspected and found empty.
export function laneManifestDigest(input: {
  lane: LegacyLane;
  inspectedScope: string;
  items: readonly { itemId: string; size: number; sha256: string }[];
}): string {
  const lines = input.items
    .map((item) => `${item.itemId}:${item.size}:${item.sha256}`)
    .sort();

  return createHash("sha256")
    .update(
      [
        LEGACY_MANIFEST_VERSION,
        input.lane,
        input.inspectedScope,
        String(lines.length),
        ...lines,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
}
