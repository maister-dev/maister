import type { LintDiagnostic } from "@/lib/flows/authored-lint";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { FlowLayout } from "@/lib/flows/graph/presentation-layout";
import type { GraphTopology } from "@/lib/flows/graph/topology";

import { parse as parseYaml } from "yaml";
import { stringify as stringifyYaml } from "yaml";

import { flowYamlV1Schema } from "@/lib/config.schema";
import { flowYamlDiagnostics } from "@/lib/flows/authored-lint";
import { compileManifest } from "@/lib/flows/graph/compile";
import { presentationLayout } from "@/lib/flows/graph/presentation-layout";
import { buildGraphTopology } from "@/lib/flows/graph/topology";

/**
 * The decision a single `yaml` text change yields under the single-owner
 * YAML↔canvas sync (spec §4.5, expectation 17):
 * - `noop`   — the parsed manifest is structurally EQUAL to what the canvas last
 *              serialized/was seeded with → DO NOT reseed (breaks the
 *              canvas→serialize-yaml→reseed-canvas loop).
 * - `reseed` — the parsed manifest DIFFERS (a genuine text-editor edit) → reseed
 *              the canvas with the new manifest + derived topology/layout.
 * - `error`  — yaml fails to parse or violates `flowYamlV1Schema`/compile → KEEP
 *              the last-good canvas; surface the diagnostics in the banner.
 */
export type YamlSyncDecision =
  | { kind: "noop" }
  | {
      kind: "reseed";
      manifest: FlowYamlV1;
      topology: GraphTopology;
      layout: FlowLayout;
    }
  | { kind: "error"; diagnostics: LintDiagnostic[] };

// Canonical structural form of a (schema-validated) manifest: re-serialize via
// the same `stringifyYaml` the canvas uses. The zod parse already normalized the
// shape (unknown keys stripped, defaults applied), so two manifests with the
// same logical content yield byte-identical canonical yaml regardless of the
// raw text's comments/whitespace/key order. This is the loop-guard comparator.
function canonical(manifest: FlowYamlV1): string {
  return stringifyYaml(manifest);
}

/**
 * Pure sync reducer — no React, no I/O. Parses `yaml`, validates it, and decides
 * whether the canvas must reseed relative to `lastManifest` (the manifest the
 * canvas currently reflects: its last-serialized or last-seeded state, or null
 * before the first seed).
 *
 * The idempotent diff is the crux: when the canvas serializes its OWN state into
 * `yaml`, that text parses back to a manifest structurally equal to
 * `lastManifest`, so this returns `noop` — the canvas is already in that state
 * and is never reseeded mid-edit. Only a text-editor change (a structurally
 * different manifest) returns `reseed`.
 */
export function syncYamlToCanvas(
  yaml: string,
  lastManifest: FlowYamlV1 | null,
): YamlSyncDecision {
  let parsed: unknown;

  try {
    parsed = parseYaml(yaml);
  } catch {
    return { kind: "error", diagnostics: flowYamlDiagnostics(yaml) };
  }

  const result = flowYamlV1Schema.safeParse(parsed);

  if (!result.success) {
    return { kind: "error", diagnostics: flowYamlDiagnostics(yaml) };
  }

  const manifest = result.data;

  if (
    lastManifest !== null &&
    canonical(manifest) === canonical(lastManifest)
  ) {
    return { kind: "noop" };
  }

  // A structurally distinct, valid manifest. compileManifest can still throw a
  // CONFIG MaisterError on a manifest the zod schema accepts but the compiler
  // rejects (e.g. neither nodes[] nor steps[]) — treat that as a kept-last-good
  // error, never a canvas wipe.
  let topology: GraphTopology;

  try {
    topology = buildGraphTopology(compileManifest(manifest));
  } catch {
    return { kind: "error", diagnostics: flowYamlDiagnostics(yaml) };
  }

  return {
    kind: "reseed",
    manifest,
    topology,
    layout: presentationLayout(manifest),
  };
}
