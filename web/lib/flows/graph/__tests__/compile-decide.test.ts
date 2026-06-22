import type { FlowYamlV1 } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { compileManifest } from "@/lib/flows/graph/compile";
import { isMaisterError } from "@/lib/errors";

// A from:verdict node routes on the verdict surfaced by exactly one
// ai_judgment/skill_check gate (compile-enforced), so the valid fixtures carry it.
const VERDICT_GATE = { id: "q", kind: "ai_judgment", prompt: "judge it" };

function manifest(node: Record<string, unknown>): FlowYamlV1 {
  return {
    schemaVersion: 1,
    name: "f",
    compat: { engine_min: "1.7.0" },
    nodes: [
      node,
      {
        id: "other",
        type: "cli",
        action: { command: "true" },
        transitions: { success: "done" },
      },
    ],
  } as unknown as FlowYamlV1;
}

function compileErr(node: Record<string, unknown>): string | null {
  try {
    compileManifest(manifest(node));

    return null;
  } catch (err) {
    return isMaisterError(err) ? err.code : "UNKNOWN";
  }
}

describe("compile-time decide verification (M38, ADR-103)", () => {
  it("rejects a from:verdict case target not in transitions (CONFIG)", () => {
    expect(
      compileErr({
        id: "j",
        type: "judge",
        action: { prompt: "x" },
        pre_finish: { gates: [VERDICT_GATE] },
        decide: {
          from: "verdict",
          cases: [
            { when: "confidence >= 0.8", target: "approve" },
            { default: true, target: "missing" },
          ],
        },
        transitions: { approve: "other" }, // "missing" has no transition
      }),
    ).toBe("CONFIG");
  });

  it("rejects a from:verdict case with an unparseable when (CONFIG)", () => {
    expect(
      compileErr({
        id: "j",
        type: "judge",
        action: { prompt: "x" },
        pre_finish: { gates: [VERDICT_GATE] },
        decide: {
          from: "verdict",
          cases: [
            { when: "confidence broken", target: "approve" },
            { default: true, target: "review" },
          ],
        },
        transitions: { approve: "other", review: "other" },
      }),
    ).toBe("CONFIG");
  });

  it("rejects a from:verdict node with no verdict-producing gate (CONFIG)", () => {
    expect(
      compileErr({
        id: "j",
        type: "judge",
        action: { prompt: "x" },
        decide: {
          from: "verdict",
          cases: [{ default: true, target: "review" }],
        },
        transitions: { review: "other" },
      }),
    ).toBe("CONFIG");
  });

  it("rejects a from:verdict node with more than one verdict gate (CONFIG)", () => {
    expect(
      compileErr({
        id: "j",
        type: "judge",
        action: { prompt: "x" },
        pre_finish: {
          gates: [
            { id: "q1", kind: "ai_judgment", prompt: "a" },
            { id: "q2", kind: "skill_check", skill: "b" },
          ],
        },
        decide: {
          from: "verdict",
          cases: [{ default: true, target: "review" }],
        },
        transitions: { review: "other" },
      }),
    ).toBe("CONFIG");
  });

  it("compiles a valid from:verdict decide and threads it onto the node", () => {
    const g = compileManifest(
      manifest({
        id: "j",
        type: "judge",
        action: { prompt: "x" },
        pre_finish: { gates: [VERDICT_GATE] },
        decide: {
          from: "verdict",
          cases: [
            { when: "confidence >= 0.8", target: "approve" },
            { default: true, target: "review" },
          ],
        },
        transitions: { approve: "other", review: "other" },
      }),
    );

    expect(g.nodes.get("j")!.decide).toEqual({
      from: "verdict",
      cases: [
        { when: "confidence >= 0.8", target: "approve" },
        { default: true, target: "review" },
      ],
    });
  });

  it("compiles a from:output decide (no cross-ref check) and threads it", () => {
    const g = compileManifest(
      manifest({
        id: "a",
        type: "ai_coding",
        action: { prompt: "x" },
        output: { result: { schema: "./s.json" } },
        decide: { from: "output.triage.outcome" },
        transitions: { bug: "other" },
      }),
    );

    expect(g.nodes.get("a")!.decide).toEqual({ from: "output.triage.outcome" });
  });

  it("rejects a from:output decide with no output.result declared (CONFIG)", () => {
    expect(
      compileErr({
        id: "a",
        type: "ai_coding",
        action: { prompt: "x" },
        decide: { from: "output.triage.outcome" },
        transitions: { bug: "other" },
      }),
    ).toBe("CONFIG");
  });

  it("rejects on_mismatch without a rework block (CONFIG)", () => {
    expect(
      compileErr({
        id: "a",
        type: "ai_coding",
        action: { prompt: "x" },
        output: { result: { schema: "./s.json", on_mismatch: "retry" } },
        transitions: { success: "other" },
      }),
    ).toBe("CONFIG");
  });

  it("rejects on_mismatch with a rework block missing commentsVar (CONFIG)", () => {
    expect(
      compileErr({
        id: "a",
        type: "ai_coding",
        action: { prompt: "x" },
        output: { result: { schema: "./s.json", on_mismatch: "retry" } },
        rework: {
          allowedTargets: ["other"],
          workspacePolicies: ["keep"],
          maxLoops: 2,
        },
        transitions: { success: "other" },
      }),
    ).toBe("CONFIG");
  });

  it("compiles on_mismatch: retry with a rework block (no own-id in allowedTargets needed)", () => {
    expect(
      compileErr({
        id: "a",
        type: "ai_coding",
        action: { prompt: "x" },
        output: { result: { schema: "./s.json", on_mismatch: "retry" } },
        rework: {
          allowedTargets: ["other"],
          workspacePolicies: ["keep"],
          maxLoops: 2,
          commentsVar: "notes",
        },
        transitions: { success: "other" },
      }),
    ).toBe(null);
  });

  it("rejects on_mismatch:<outcome> whose target is not in rework.allowedTargets (CONFIG)", () => {
    expect(
      compileErr({
        id: "a",
        type: "ai_coding",
        action: { prompt: "x" },
        output: { result: { schema: "./s.json", on_mismatch: "redo" } },
        rework: {
          allowedTargets: ["other"],
          workspacePolicies: ["keep"],
          maxLoops: 2,
          commentsVar: "notes",
        },
        transitions: { redo: "done" }, // "done" terminal, not in allowedTargets
      }),
    ).toBe("CONFIG");
  });

  it("compiles on_mismatch:<outcome> routed to an allowed rework target", () => {
    expect(
      compileErr({
        id: "a",
        type: "ai_coding",
        action: { prompt: "x" },
        output: { result: { schema: "./s.json", on_mismatch: "redo" } },
        rework: {
          allowedTargets: ["other"],
          workspacePolicies: ["keep"],
          maxLoops: 2,
          commentsVar: "notes",
        },
        transitions: { redo: "other" },
      }),
    ).toBe(null);
  });
});
