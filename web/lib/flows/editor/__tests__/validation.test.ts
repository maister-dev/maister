import type { FlowYamlV1 } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { validateEditorManifest } from "@/lib/flows/editor/validation";

// Hand-built (intentionally invalid) manifests — cannot go through
// flowYamlV1Schema.parse (it would throw). validateEditorManifest iterates
// nodes and validates each with the per-node zod.
function manifest(nodes: unknown[]): FlowYamlV1 {
  return { schemaVersion: 1, name: "t", nodes } as unknown as FlowYamlV1;
}

describe("validateEditorManifest", () => {
  it("a fully valid manifest → ok, no issues", () => {
    const result = validateEditorManifest(
      manifest([
        { id: "plan", type: "ai_coding", action: { prompt: "p" } },
        { id: "review", type: "human" },
      ]),
    );

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("maps a node settings error to the offending nodeId (no gateId)", () => {
    const result = validateEditorManifest(
      manifest([
        {
          id: "plan",
          type: "ai_coding",
          action: { prompt: "p" },
          settings: { thinkingEffort: "ultra" },
        },
      ]),
    );

    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.nodeId === "plan");

    expect(issue).toBeDefined();
    expect(issue?.gateId).toBeUndefined();
  });

  it("maps a missing action.prompt to the nodeId", () => {
    const result = validateEditorManifest(
      manifest([{ id: "plan", type: "ai_coding", action: {} }]),
    );

    expect(result.issues.some((i) => i.nodeId === "plan")).toBe(true);
  });

  it("maps a decide error (verdict, no default) to the nodeId (no gateId)", () => {
    const result = validateEditorManifest(
      manifest([
        {
          id: "triage",
          type: "judge",
          action: { prompt: "p" },
          decide: {
            from: "verdict",
            cases: [{ when: "confidence >= 0.8", target: "approve" }],
          },
        },
      ]),
    );

    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.nodeId === "triage");

    expect(issue).toBeDefined();
    expect(issue?.gateId).toBeUndefined();
  });

  it("maps a human_review-blocking gate error to nodeId + gateId", () => {
    const result = validateEditorManifest(
      manifest([
        {
          id: "review",
          type: "human",
          pre_finish: {
            gates: [{ id: "g1", kind: "human_review", mode: "blocking" }],
          },
        },
      ]),
    );

    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.gateId === "g1");

    expect(issue).toBeDefined();
    expect(issue?.nodeId).toBe("review");
  });
});
