// Client-safe form view of `maister-package.yaml` (ADR-105, M39 Stream A). The
// PackageManifestForm edits the scalar fields (name + metadata.title/summary);
// the entry arrays (flows/capabilities/mcps/restrictions) are PRESERVED verbatim
// and shown read-only — they are authored per file (the file tree) or via the raw
// YAML toggle. `raw` holds the full parsed object so re-serialization never drops
// a field the form does not surface. No `server-only`, no `node:*` — the editor
// imports this in the browser bundle (mirrors lib/flows/artifact-validate.ts).

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { maisterPackageManifestSchema } from "@/lib/config.schema";

// Client-safe mirror of lib/packages/manifest.ts's `PACKAGE_MANIFEST_FILENAME`
// (that module is `server-only`). The classifier maps this exact name to the
// `manifest` kind.
export const PACKAGE_MANIFEST_FILENAME = "maister-package.yaml";

export type ManifestEntrySummary = { id: string; path: string };

// Homed here (not in the `"use client"` form component) so the server-side label
// builder in lib/flows/editor/editor-labels.ts can reference the shape without a
// client-into-lib import.
export type PackageManifestFormLabels = {
  heading: string;
  name: string;
  displayTitle: string;
  summary: string;
  flows: string;
  capabilities: string;
  mcps: string;
  restrictions: string;
  formMode: string;
  rawMode: string;
  parseError: string;
  empty: string;
};

export type PackageManifestModel = {
  name: string;
  title: string;
  summary: string;
  flows: ManifestEntrySummary[];
  capabilities: ManifestEntrySummary[];
  mcpCount: number;
  restrictionCount: number;
};

export type ManifestParse =
  | { ok: true; model: PackageManifestModel; raw: Record<string, unknown> }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function entrySummaries(value: unknown): ManifestEntrySummary[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === "string"
      ? [
          {
            id: entry.id,
            path: typeof entry.path === "string" ? entry.path : "",
          },
        ]
      : [],
  );
}

// Lenient parse for the FORM: an empty file is an empty mapping (so the form can
// seed fields on a fresh package); a non-mapping or unparseable YAML is an error
// (the form falls back to raw-only).
export function parsePackageManifest(yaml: string): ManifestParse {
  let data: unknown;

  try {
    data = parseYaml(yaml);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (data === null || data === undefined) data = {};

  if (!isRecord(data)) {
    return { ok: false, error: "manifest must be a YAML mapping" };
  }

  const metadata = isRecord(data.metadata) ? data.metadata : {};

  return {
    ok: true,
    raw: data,
    model: {
      name: typeof data.name === "string" ? data.name : "",
      title: typeof metadata.title === "string" ? metadata.title : "",
      summary: typeof metadata.summary === "string" ? metadata.summary : "",
      flows: entrySummaries(data.flows),
      capabilities: entrySummaries(data.capabilities),
      mcpCount: Array.isArray(data.mcps) ? data.mcps.length : 0,
      restrictionCount: Array.isArray(data.restrictions)
        ? data.restrictions.length
        : 0,
    },
  };
}

// Merge scalar edits onto the parsed `raw` object (preserving arrays + unknown
// keys + key order) and re-serialize. An empty title/summary removes the key; an
// emptied `metadata` is dropped entirely.
export function applyManifestScalars(
  raw: Record<string, unknown>,
  edits: { name: string; title: string; summary: string },
): string {
  const next: Record<string, unknown> = { ...raw, name: edits.name };
  const metadata: Record<string, unknown> = isRecord(raw.metadata)
    ? { ...raw.metadata }
    : {};

  if (edits.title.trim()) metadata.title = edits.title.trim();
  else delete metadata.title;
  if (edits.summary.trim()) metadata.summary = edits.summary.trim();
  else delete metadata.summary;

  if (Object.keys(metadata).length > 0) next.metadata = metadata;
  else delete next.metadata;

  return stringifyYaml(next);
}

// Serialize a fresh scaffold manifest (M39 A4): the manifest `name` is the
// slug-safe capabilityRefId (NOT the display name — that would violate
// `capabilityRefIdSchema`); the human-readable display goes to `metadata.title`.
// `flows` starts empty (now valid — empty packages are allowed).
export function serializeScaffoldManifest(name: string, title: string): string {
  return stringifyYaml({
    schemaVersion: 1,
    name,
    metadata: { title },
    flows: [],
  });
}

// Append a flow entry to a manifest's `flows[]`, preserving every other field +
// key order, and re-serialize. Idempotent on `id` (a flow already listed is not
// duplicated). Used when a flow element fork copies a flow into a package — the
// flow must be registered in the manifest or it is dead weight at install time.
export function appendManifestFlow(
  raw: Record<string, unknown>,
  entry: { id: string; path: string },
): string {
  const flows = Array.isArray(raw.flows) ? [...raw.flows] : [];
  const present = flows.some((f) => isRecord(f) && f.id === entry.id);
  const nextFlows = present
    ? flows
    : [...flows, { id: entry.id, path: entry.path }];

  return stringifyYaml({ ...raw, flows: nextFlows });
}

// Rename a flow entry's identity in `flows[]` (id + path), preserving every other
// field + key order, and re-serialize. Used by the card-level flow rename
// (ADR-116 P6): a flow rename that updates the file but not the manifest is a
// defect, so both move together. A no-match leaves the manifest unchanged.
export function renameManifestFlow(
  raw: Record<string, unknown>,
  oldId: string,
  entry: { id: string; path: string },
): string {
  const flows = Array.isArray(raw.flows) ? raw.flows : [];
  const nextFlows = flows.map((f) =>
    isRecord(f) && f.id === oldId
      ? { ...f, id: entry.id, path: entry.path }
      : f,
  );

  return stringifyYaml({ ...raw, flows: nextFlows });
}

// Strict validation against the install-time manifest schema. Returns the issue
// list (empty = valid). Reused by the M39 commit-time gate (Phase A3) and the
// editor's inline content-issues.
export function validatePackageManifestYaml(yaml: string): string[] {
  let data: unknown;

  try {
    data = parseYaml(yaml);
  } catch (err) {
    return [
      `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
    ];
  }

  const parsed = maisterPackageManifestSchema.safeParse(data);

  if (parsed.success) return [];

  return parsed.error.issues.map(
    (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
  );
}
