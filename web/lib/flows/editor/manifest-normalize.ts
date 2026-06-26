import type { FlowYamlV1 } from "@/lib/config.schema";

// The node-form free-text list control (StringListField) lets the author keep a
// transient blank row mid-edit — good UX — but every field it edits is
// `z.array(z.string().min(1))`, so a persisted "" or whitespace-only entry fails
// validation at compile/launch (CONFIG). The legacy comma inputs filtered these
// via `.split(",").map(trim).filter(Boolean)`; the structured control does not,
// so we re-establish the same guarantee at the one canvas→YAML serialize
// boundary — NOT per-keystroke, which would erase the row the author is mid-way
// through typing. (MultiSelectField trims and rejects empties at add-time, so it
// never leaks a blank — only StringListField does.)
//
// Scoped to the KNOWN DSL list-field keys below, never an arbitrary string
// array: the flow manifest and every node shape are `.passthrough()`, so author
// extension keys (e.g. `x-*` string arrays) survive parsing and MUST be
// preserved verbatim — a blanket prune would silently corrupt them. Trims kept
// values (matching the legacy filter) and omits a list that becomes empty
// (sparse convention). Pure; never mutates the input.
const PRUNED_LIST_FIELDS: ReadonlySet<string> = new Set([
  "restrictions", // ai_coding / orchestrator / judge settings
  "decisions", // human settings + finish.human
  "roles", // human / form settings
  "assignees", // human settings
  "allowedTargets", // rework
  "allowedPaths", // settings.hooks.pathGuard
  "material_axes", // consensus
]);

export function pruneEmptyListEntries(manifest: FlowYamlV1): FlowYamlV1 {
  return prune(manifest) as FlowYamlV1;
}

function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune);

  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value)) {
      if (PRUNED_LIST_FIELDS.has(key) && isNonEmptyStringArray(entry)) {
        const cleaned = entry
          .map((item) => item.trim())
          .filter((item) => item.length > 0);

        if (cleaned.length > 0) out[key] = cleaned;
        // else: omit the now-empty list (sparse — matches the legacy filter).
      } else {
        out[key] = prune(entry);
      }
    }

    return out;
  }

  return value;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string")
  );
}
