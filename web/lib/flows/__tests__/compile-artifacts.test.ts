import type { FlowYamlV1 } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { compileManifest } from "@/lib/flows/graph/compile";

describe("compile — typed artifacts (T3.1)", () => {
  it("CompiledNode exposes input.requires from NodeDef on graph-based manifest", () => {
    const manifest: FlowYamlV1 = {
      schemaVersion: 1,
      name: "Test Flow with Artifacts",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "implement",
          type: "ai_coding",
          input: {
            requires: ["specification"],
          },
          action: { prompt: "implement the specification" },
        },
      ],
    };

    const graph = compileManifest(manifest);
    const implementNode = graph.nodes.get("implement");

    expect(implementNode).toBeDefined();
    expect(implementNode?.input).toBeDefined();
    expect(implementNode?.input?.requires).toContain("specification");
  });

  it("CompiledNode exposes output.produces from NodeDef on graph-based manifest", () => {
    const manifest: FlowYamlV1 = {
      schemaVersion: 1,
      name: "Test Flow with Artifacts",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "implement",
          type: "ai_coding",
          output: {
            produces: [
              {
                id: "impl-diff",
                kind: "diff",
              },
              {
                id: "impl-log",
                kind: "log",
              },
            ],
          },
          action: { prompt: "implement and produce artifacts" },
        },
      ],
    };

    const graph = compileManifest(manifest);
    const implementNode = graph.nodes.get("implement");

    expect(implementNode).toBeDefined();
    expect(implementNode?.output).toBeDefined();
    expect(implementNode?.output?.produces).toHaveLength(2);
    expect(implementNode?.output?.produces?.[0]).toEqual({
      id: "impl-diff",
      kind: "diff",
    });
    expect(implementNode?.output?.produces?.[1]).toEqual({
      id: "impl-log",
      kind: "log",
    });
  });

  it("CompiledNode input/output are undefined when NodeDef has none", () => {
    const manifest: FlowYamlV1 = {
      schemaVersion: 1,
      name: "Test Flow No Artifacts",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "simple",
          type: "cli",
          action: { command: "echo done" },
        },
      ],
    };

    const graph = compileManifest(manifest);
    const simpleNode = graph.nodes.get("simple");

    expect(simpleNode).toBeDefined();
    expect(simpleNode?.input).toBeUndefined();
    expect(simpleNode?.output).toBeUndefined();
  });

  it("CompiledNode input.requires can be array of strings (simple artifact ids)", () => {
    const manifest: FlowYamlV1 = {
      schemaVersion: 1,
      name: "Test Flow with Simple Requires",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "review",
          type: "human",
          input: {
            requires: ["impl-diff", "test-report"],
          },
          action: {},
        },
      ],
    };

    const graph = compileManifest(manifest);
    const reviewNode = graph.nodes.get("review");

    expect(reviewNode?.input?.requires).toEqual(["impl-diff", "test-report"]);
  });

  it("CompiledNode output.produces preserves all metadata from NodeDef (schema, path, visibility)", () => {
    const manifest: FlowYamlV1 = {
      schemaVersion: 1,
      name: "Test Flow with Full Artifact Metadata",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "check",
          type: "cli",
          output: {
            produces: [
              {
                id: "check-report",
                kind: "test_report",
                schema: "junit",
                path: "junit.xml",
                visibility: "shared",
              },
            ],
          },
          action: { command: "npm test" },
        },
      ],
    };

    const graph = compileManifest(manifest);
    const checkNode = graph.nodes.get("check");
    const report = checkNode?.output?.produces?.[0];

    expect(report).toEqual({
      id: "check-report",
      kind: "test_report",
      schema: "junit",
      path: "junit.xml",
      visibility: "shared",
    });
  });

  it("Linear (steps-based) manifest nodes do NOT populate input/output (backward compat)", () => {
    const manifest: FlowYamlV1 = {
      schemaVersion: 1,
      name: "Linear Test Flow",
      steps: [
        {
          id: "plan",
          type: "agent",
          mode: "new-session",
          prompt: "plan the work",
        },
      ],
    };

    const graph = compileManifest(manifest);
    const planNode = graph.nodes.get("plan");

    expect(planNode).toBeDefined();
    // Linear nodes should not have input/output because they come from Step, not NodeDef
    expect(planNode?.input).toBeUndefined();
    expect(planNode?.output).toBeUndefined();
  });
});
