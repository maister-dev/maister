import type { LocalPackage } from "@/lib/db/schema";

import { beforeEach, describe, expect, it, vi } from "vitest";

const readWorkingDirArtifactFilesMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/local-packages/service", () => ({
  readWorkingDirArtifactFiles: readWorkingDirArtifactFilesMock,
}));

vi.mock("@/lib/local-packages/validate", () => ({
  validatePackageArtifacts: () => [],
}));

vi.mock("@/lib/queries/authored-flow-graph", () => {
  type MockNode = {
    id: string;
    type: string;
    transitions?: Record<string, string>;
  };
  type MockManifest = {
    nodes?: MockNode[];
    steps?: MockNode[];
  };

  function manifestNodes(manifest: MockManifest): MockNode[] {
    return manifest.nodes ?? manifest.steps ?? [];
  }

  return {
    buildAuthoredFlowGraph: (manifest: MockManifest) => ({
      topology: {
        nodes: manifestNodes(manifest).map((node) => ({
          id: node.id,
          nodeType: node.type,
          displayLabel: node.id,
        })),
        edges: manifestNodes(manifest).flatMap((node) =>
          Object.entries(node.transitions ?? {}).map(([label, target]) => ({
            source: node.id,
            target,
            displayLabel: label,
          })),
        ),
      },
    }),
  };
});

vi.mock("../actions", () => ({
  packageFileHash: () => "sha256:test",
}));

import { buildFlowDslGrammar } from "@/lib/flows/flow-dsl-grammar";
import { buildFlowAssistantContext } from "@/lib/studio/flow-assistant/context";

const localPackage = {
  id: "lp-1",
  name: "Test Package",
  slug: "test-package",
} as unknown as LocalPackage;

describe("buildFlowAssistantContext", () => {
  beforeEach(() => {
    readWorkingDirArtifactFilesMock.mockResolvedValue([]);
  });

  it("injects the authoritative Flow DSL grammar on every turn", async () => {
    const ctx = await buildFlowAssistantContext({
      localPackage,
      intent: "auto",
    });

    expect(ctx.prompt).toContain(buildFlowDslGrammar());
    expect(ctx.prompt).toContain("type: consensus");
    expect(ctx.prompt).toContain("authoritative Flow DSL grammar section");
  });

  it("injects the selected node template variable catalog", async () => {
    readWorkingDirArtifactFilesMock.mockResolvedValue([
      {
        path: "flows/review/flow.yaml",
        content: `schemaVersion: 1
name: Review flow
nodes:
  - id: intake
    type: form
    settings:
      form_schema: ./schemas/intake.json
    transitions:
      success: plan
  - id: plan
    type: ai_coding
    action:
      prompt: Plan from {{ task.prompt }}
    output:
      result:
        schema: ./schemas/plan.json
      produces:
        - id: plan_doc
          kind: plan
    transitions:
      success: review
  - id: review
    type: ai_coding
    action:
      prompt: Review the plan
`,
      },
      {
        path: "schemas/intake.json",
        content: JSON.stringify({
          schemaVersion: 1,
          fields: [{ name: "title", type: "string", required: true }],
        }),
      },
      {
        path: "schemas/plan.json",
        content: JSON.stringify({
          schemaVersion: 1,
          fields: [
            { name: "verdict", type: "string", required: true },
            { name: "notes", type: "string" },
          ],
        }),
      },
    ]);

    const ctx = await buildFlowAssistantContext({
      localPackage,
      intent: "edit",
      focus: {
        path: "flows/review/flow.yaml",
        selectedNodeId: "review",
      },
    });

    expect(ctx.selectedNodeId).toBe("review");
    expect(ctx.prompt).toContain("## Selected node template variables");
    expect(ctx.prompt).toContain("Selected node: review");
    expect(ctx.prompt).toContain(
      "steps.intake.vars.title | source=step | availability=definite | presence=required | insertText=`{{ steps.intake.vars.title }}`",
    );
    expect(ctx.prompt).toContain(
      "steps.plan.vars.notes | source=step | availability=definite | presence=optional | insertText=`{{ steps.plan.vars.notes ?? '' }}`",
    );
    expect(ctx.prompt).toContain(
      "artifacts.plan_doc.uri | source=artifact | availability=definite | presence=optional | insertText=`{{ artifacts.plan_doc.uri ?? '' }}`",
    );
    expect(ctx.prompt).toContain("Unavailable at selected node:");
    expect(ctx.prompt).toContain("steps.review.output");
  });
});
