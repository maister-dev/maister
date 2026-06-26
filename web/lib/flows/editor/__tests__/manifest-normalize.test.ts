import { describe, expect, it } from "vitest";

import { flowYamlV1Schema } from "@/lib/config.schema";
import { pruneEmptyListEntries } from "@/lib/flows/editor/manifest-normalize";

describe("pruneEmptyListEntries", () => {
  it("strips empty/whitespace-only entries and trims kept values", () => {
    const pruned = pruneEmptyListEntries({
      schemaVersion: 1,
      name: "t",
      nodes: [
        {
          id: "plan",
          type: "ai_coding",
          action: { prompt: "do" },
          settings: { restrictions: ["keep", "", "  trim  ", "   "] },
          transitions: { success: "done" },
        },
      ],
    } as never) as { nodes: { settings: { restrictions: string[] } }[] };

    expect(pruned.nodes[0].settings.restrictions).toEqual(["keep", "trim"]);
  });

  it("omits a list that becomes empty after pruning", () => {
    const pruned = pruneEmptyListEntries({
      schemaVersion: 1,
      name: "t",
      nodes: [
        {
          id: "plan",
          type: "ai_coding",
          action: { prompt: "do" },
          settings: { restrictions: ["", "   "], model: "m" },
          transitions: { success: "done" },
        },
      ],
    } as never) as { nodes: { settings: Record<string, unknown> }[] };

    expect("restrictions" in pruned.nodes[0].settings).toBe(false);
    expect(pruned.nodes[0].settings.model).toBe("m");
  });

  it("makes a blank-row manifest parse under flowYamlV1Schema (the regression)", () => {
    // A node-form session that left blank rows in every StringListField-backed
    // field. Raw, this fails z.array(z.string().min(1)); pruned, it must parse.
    const raw = {
      schemaVersion: 1,
      name: "blank-rows",
      nodes: [
        {
          id: "fix",
          type: "ai_coding",
          action: { prompt: "go" },
          settings: {
            restrictions: ["no-network", ""],
            hooks: { pathGuard: { allowedPaths: ["src/**", ""] } },
          },
          rework: {
            allowedTargets: ["fix", ""],
            workspacePolicies: ["keep"],
            maxLoops: 1,
          },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "human",
          settings: { roles: ["maintainer", ""], decisions: ["approve", ""] },
          transitions: { approve: "done" },
        },
        {
          id: "agree",
          type: "consensus",
          prompt: "agree",
          participants: [
            { id: "a", runner: "claude-code" },
            { id: "b", runner: "codex" },
          ],
          material_axes: ["scope", ""],
          rounds: { mode: "single_pass", max: 1 },
          on_no_consensus: "escalate",
          synthesizer: { runner: "claude-code" },
          output: { produces: [{ id: "plan", kind: "plan" }] },
          transitions: { success: "done" },
        },
      ],
    };

    expect(() => flowYamlV1Schema.parse(raw)).toThrow();
    expect(() =>
      flowYamlV1Schema.parse(pruneEmptyListEntries(raw as never)),
    ).not.toThrow();
  });

  it("leaves arrays of objects (produces, participants) untouched", () => {
    const pruned = pruneEmptyListEntries({
      schemaVersion: 1,
      name: "t",
      nodes: [
        {
          id: "agree",
          type: "consensus",
          prompt: "p",
          participants: [
            { id: "a", runner: "r" },
            { id: "b", runner: "r2" },
          ],
          material_axes: ["axis"],
          rounds: { mode: "single_pass", max: 1 },
          on_no_consensus: "escalate",
          synthesizer: { runner: "r" },
          output: { produces: [{ id: "plan", kind: "plan" }] },
          transitions: { success: "done" },
        },
      ],
    } as never) as {
      nodes: { participants: unknown[]; output: { produces: unknown[] } }[];
    };

    expect(pruned.nodes[0].participants).toHaveLength(2);
    expect(pruned.nodes[0].output.produces).toEqual([
      { id: "plan", kind: "plan" },
    ]);
  });

  it("preserves passthrough extension string arrays (prunes only known DSL keys)", () => {
    // Node schemas + the manifest are `.passthrough()`; `x-*` extension arrays
    // are a supported, tested feature (manifest-io.test.ts). They must survive a
    // canvas save verbatim while a targeted DSL list field is still cleaned.
    const pruned = pruneEmptyListEntries({
      schemaVersion: 1,
      name: "ext",
      "x-flow-tags": ["keep", "", "  spaced  "],
      nodes: [
        {
          id: "plan",
          type: "ai_coding",
          action: { prompt: "do" },
          settings: { restrictions: ["a", ""] },
          "x-lanes": ["  lane-a  ", ""],
          transitions: { success: "done" },
        },
      ],
    } as never) as unknown as {
      "x-flow-tags": string[];
      nodes: Array<{
        "x-lanes": string[];
        settings: { restrictions: string[] };
      }>;
    };

    expect(pruned["x-flow-tags"]).toEqual(["keep", "", "  spaced  "]);
    expect(pruned.nodes[0]["x-lanes"]).toEqual(["  lane-a  ", ""]);
    expect(pruned.nodes[0].settings.restrictions).toEqual(["a"]);
  });

  it("does not mutate the input", () => {
    const input = {
      schemaVersion: 1,
      name: "t",
      nodes: [
        {
          id: "plan",
          type: "ai_coding",
          action: { prompt: "do" },
          settings: { restrictions: ["a", ""] },
          transitions: { success: "done" },
        },
      ],
    };

    pruneEmptyListEntries(input as never);

    expect(input.nodes[0].settings.restrictions).toEqual(["a", ""]);
  });
});
