// T3.3 (RED): unit tests for the PURE yaml→canvas sync reducer (no jsdom, no
// React). The reducer is the crux of the single-owner YAML↔canvas sync (spec
// §4.5, expectation 17): it decides whether a `yaml` text change must re-seed
// the canvas. The loop hazard (canvas→serialize-yaml→reseed-canvas) is broken by
// IDEMPOTENT diffing — a yaml the canvas itself serialized parses back to the
// SAME manifest as `lastManifest`, so the reducer returns a no-op (no reseed).
// Only a genuine text edit (a structurally DIFFERENT manifest) reseeds.
//
// Contract (module not built yet — RED on the missing import):
//   web/lib/flows/editor/yaml-sync.ts exports
//     syncYamlToCanvas(yaml: string, lastManifest: FlowYamlV1 | null):
//       | { kind: "noop" }
//       | { kind: "reseed"; manifest; topology; layout }
//       | { kind: "error"; diagnostics: LintDiagnostic[] }

import type { FlowYamlV1 } from "@/lib/config.schema";

import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";

import { flowYamlV1Schema } from "@/lib/config.schema";
import { syncYamlToCanvas } from "@/lib/flows/editor/yaml-sync";

function manifest(): FlowYamlV1 {
  return flowYamlV1Schema.parse({
    schemaVersion: 1,
    name: "Demo Flow",
    nodes: [
      {
        id: "plan",
        type: "ai_coding",
        action: { prompt: "do plan" },
        transitions: { success: "review" },
      },
      {
        id: "review",
        type: "human",
        settings: { decisions: ["approve"] },
      },
    ],
  });
}

describe("syncYamlToCanvas — idempotent loop guard", () => {
  it("returns noop when the yaml parses to the SAME manifest the canvas last serialized (no reseed → no loop)", () => {
    const current = manifest();
    // The canvas serializes its own state via stringifyYaml(manifest); feeding
    // that text back through the reducer with the same lastManifest must NOT
    // reseed — this is what prevents the infinite reseed/serialize cycle.
    const canvasSerialized = stringifyYaml(current);

    const decision = syncYamlToCanvas(canvasSerialized, current);

    expect(decision.kind).toBe("noop");
  });

  it("is stable across a parse→serialize→parse round-trip (whitespace/formatting differences do not reseed)", () => {
    const current = manifest();
    // A semantically identical but differently-formatted yaml (extra blank
    // lines, reordered keys via re-stringify) still parses to the same manifest.
    const reformatted = `\n# a comment\n${stringifyYaml(current)}\n`;

    const decision = syncYamlToCanvas(reformatted, current);

    expect(decision.kind).toBe("noop");
  });

  it("returns error (kept-last-good) when yaml is empty and lastManifest is null — no spurious canvas wipe", () => {
    const decision = syncYamlToCanvas("", null);

    // Empty yaml is not a valid flow manifest → error (kept-last-good), never a
    // spurious reseed. The canvas is never wiped on a transient/empty buffer.
    expect(decision.kind).toBe("error");
  });
});

describe("syncYamlToCanvas — genuine text edit reseeds", () => {
  it("reseeds with the new manifest + topology + layout when the parsed manifest DIFFERS (text editor edit)", () => {
    const current = manifest();
    const edited = manifest();

    // A real text edit: add a third node + wire plan→failure to it.
    edited.nodes = [
      ...(edited.nodes ?? []),
      {
        id: "fix",
        type: "cli",
        action: { command: "echo fix" },
      } as NonNullable<FlowYamlV1["nodes"]>[number],
    ];
    (edited.nodes[0] as { transitions?: Record<string, string> }).transitions =
      {
        success: "review",
        failure: "fix",
      };

    const decision = syncYamlToCanvas(stringifyYaml(edited), current);

    expect(decision.kind).toBe("reseed");
    if (decision.kind !== "reseed") return;

    expect(decision.manifest.nodes?.map((n) => n.id)).toEqual([
      "plan",
      "review",
      "fix",
    ]);
    // topology reflects the new node + the new typed edge.
    expect(decision.topology.nodes.map((n) => n.id)).toContain("fix");
    expect(
      decision.topology.edges.some(
        (e) => e.source === "plan" && e.target === "fix",
      ),
    ).toBe(true);
    // layout is the presentation projection (empty here — no authored coords).
    expect(decision.layout).toEqual({});
  });

  it("reseeds against a null lastManifest when the yaml is a valid manifest (first seed / external set)", () => {
    const decision = syncYamlToCanvas(stringifyYaml(manifest()), null);

    expect(decision.kind).toBe("reseed");
    if (decision.kind !== "reseed") return;

    expect(decision.manifest.nodes?.map((n) => n.id)).toEqual([
      "plan",
      "review",
    ]);
  });

  it("projects authored presentation coordinates into the reseed layout", () => {
    const withPres = manifest();

    withPres.presentation = {
      nodes: [{ id: "plan", x: 40, y: 80, width: 120, color: "accent" }],
    };

    const decision = syncYamlToCanvas(stringifyYaml(withPres), null);

    expect(decision.kind).toBe("reseed");
    if (decision.kind !== "reseed") return;

    expect(decision.layout).toEqual({
      plan: { x: 40, y: 80, width: 120, color: "accent" },
    });
  });
});

describe("syncYamlToCanvas — error keeps last-good", () => {
  it("returns error with diagnostics on a YAML parse failure (canvas NOT wiped)", () => {
    const decision = syncYamlToCanvas("nodes: [ : : :\n  bad", manifest());

    expect(decision.kind).toBe("error");
    if (decision.kind !== "error") return;

    expect(decision.diagnostics.length).toBeGreaterThan(0);
    expect(decision.diagnostics[0].severity).toBe("error");
  });

  it("returns error with schema diagnostics when the yaml parses but fails flowYamlV1Schema", () => {
    // Valid YAML, invalid flow manifest (no name, no nodes/steps).
    const decision = syncYamlToCanvas("schemaVersion: 1\n", manifest());

    expect(decision.kind).toBe("error");
    if (decision.kind !== "error") return;

    expect(decision.diagnostics.length).toBeGreaterThan(0);
  });

  it("never reseeds on error — the error decision carries no manifest", () => {
    const decision = syncYamlToCanvas("::: not yaml :::", manifest());

    expect(decision.kind).toBe("error");
    expect(decision).not.toHaveProperty("manifest");
  });
});
