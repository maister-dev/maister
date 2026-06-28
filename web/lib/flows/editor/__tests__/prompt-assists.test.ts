import type { FlowYamlV1 } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { buildPromptAssistsForNode } from "@/lib/flows/editor/prompt-assists";

function file(
  path: string,
  content: string,
): { path: string; content: string } {
  return { path, content };
}

function schema(fields: unknown[]): string {
  return JSON.stringify({ schemaVersion: 1, fields });
}

const manifest: FlowYamlV1 = {
  schemaVersion: 1,
  name: "Prompt assists",
  nodes: [
    {
      id: "plan",
      type: "ai_coding",
      action: { prompt: "Plan" },
      output: { result: { schema: "./schemas/plan.json" } },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "judge",
      action: {
        prompt: "{{ steps.plan.vars.verdict }} {{ steps.review.output }}",
      },
    },
    {
      id: "shell",
      type: "cli",
      action: { command: "echo ok" },
    },
  ],
} as FlowYamlV1;

describe("buildPromptAssistsForNode", () => {
  it("derives selected-node variables from current draft schema files", () => {
    const assists = buildPromptAssistsForNode({
      manifest,
      selectedNodeId: "review",
      files: [
        file(
          "schemas/plan.json",
          schema([{ name: "verdict", type: "string", required: true }]),
        ),
      ],
    });

    expect(assists.variableCatalog.map((entry) => entry.path)).toContain(
      "steps.plan.vars.verdict",
    );
    expect(assists.variableWarnings).toEqual([
      expect.objectContaining({
        code: "unavailable_path",
        path: "steps.review.output",
      }),
    ]);
  });

  it("recomputes schema-derived variables when draft file contents change", () => {
    const first = buildPromptAssistsForNode({
      manifest,
      selectedNodeId: "review",
      files: [
        file(
          "schemas/plan.json",
          schema([{ name: "verdict", type: "string", required: true }]),
        ),
      ],
    });
    const second = buildPromptAssistsForNode({
      manifest,
      selectedNodeId: "review",
      files: [
        file(
          "schemas/plan.json",
          schema([{ name: "confidence", type: "number", required: true }]),
        ),
      ],
    });

    expect(first.variableCatalog.map((entry) => entry.path)).toContain(
      "steps.plan.vars.verdict",
    );
    expect(second.variableCatalog.map((entry) => entry.path)).toContain(
      "steps.plan.vars.confidence",
    );
  });

  it("returns only globals when no node is selected", () => {
    const assists = buildPromptAssistsForNode({
      manifest,
      selectedNodeId: null,
      files: [],
    });

    expect(assists.variableCatalog.map((entry) => entry.path)).toEqual([
      "task.id",
      "task.title",
      "task.prompt",
      "task.attemptNumber",
      "run.id",
      "run.attemptNumber",
      "run.projectSlug",
      "executor.id",
      "executor.agent",
      "executor.model",
      "executor.router",
    ]);
    expect(assists.variableWarnings).toEqual([]);
  });

  it("omits variable assists for non-prompt nodes", () => {
    const assists = buildPromptAssistsForNode({
      manifest,
      selectedNodeId: "shell",
      files: [],
    });

    expect(assists.variableCatalog).toEqual([]);
    expect(assists.variableWarnings).toEqual([]);
  });

  it("surfaces schema catalog warnings for invalid refs without throwing", () => {
    const assists = buildPromptAssistsForNode({
      manifest: {
        ...manifest,
        nodes: [
          {
            id: "plan",
            type: "ai_coding",
            action: { prompt: "Plan" },
            output: { result: { schema: "../secret.json" } },
            transitions: { success: "review" },
          },
          {
            id: "review",
            type: "judge",
            action: { prompt: "Review" },
          },
        ],
      } as FlowYamlV1,
      selectedNodeId: "review",
      files: [file("schemas/secret.json", schema([]))],
    });

    expect(assists.catalogWarnings).toEqual([
      expect.objectContaining({ code: "schema_ref_out_of_scope" }),
    ]);
  });
});
