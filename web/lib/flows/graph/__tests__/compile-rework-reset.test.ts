import type { FlowYamlV1 } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { compileManifest } from "@/lib/flows/graph/compile";
import { isMaisterError } from "@/lib/errors";

// ADR-118: compile-time verification of `rework.onExhaustion` (a loop node's
// exhaustion routing key) and `rework.resetTargets` (a human node's loop-counter
// reset list). Mirrors verifyDecideAndOnMismatch. Engine floor (>= 2.1.0) is
// load-time (config.ts) and covered separately.

function manifest(nodes: Record<string, unknown>[]): FlowYamlV1 {
  return {
    schemaVersion: 1,
    name: "f",
    compat: { engine_min: "2.1.0" },
    nodes,
  } as unknown as FlowYamlV1;
}

function compileErr(nodes: Record<string, unknown>[]): string | null {
  try {
    compileManifest(manifest(nodes));

    return null;
  } catch (err) {
    return isMaisterError(err) ? err.code : "UNKNOWN";
  }
}

const loopNode = (over: Record<string, unknown> = {}) => ({
  id: "loop",
  type: "ai_coding",
  action: { prompt: "x" },
  transitions: { success: "done" },
  rework: {
    allowedTargets: ["loop"],
    workspacePolicies: ["keep"],
    maxLoops: 2,
    commentsVar: "c",
  },
  ...over,
});

describe("compile-time rework onExhaustion verification (ADR-118)", () => {
  it("accepts onExhaustion that IS a declared transition key", () => {
    expect(
      compileErr([
        {
          id: "verify",
          type: "judge",
          action: { prompt: "x" },
          transitions: { success: "done", exhausted: "done" },
          rework: {
            allowedTargets: ["verify"],
            workspacePolicies: ["keep"],
            maxLoops: 2,
            onExhaustion: "exhausted",
          },
        },
      ]),
    ).toBeNull();
  });

  it("rejects onExhaustion NOT in the node's transitions (CONFIG)", () => {
    expect(
      compileErr([
        {
          id: "verify",
          type: "judge",
          action: { prompt: "x" },
          transitions: { success: "done" },
          rework: {
            allowedTargets: ["verify"],
            workspacePolicies: ["keep"],
            maxLoops: 2,
            onExhaustion: "nope",
          },
        },
      ]),
    ).toBe("CONFIG");
  });
});

describe("compile-time rework resetTargets verification (ADR-118)", () => {
  it("accepts a resetTargets pointing at a reachable rework-loop node", () => {
    expect(
      compileErr([
        loopNode(),
        {
          id: "human",
          type: "human",
          finish: { human: { decisions: ["approve", "rework"] } },
          transitions: { approve: "done", rework: "loop" },
          rework: {
            allowedTargets: ["loop"],
            workspacePolicies: ["keep"],
            maxLoops: 2,
            resetTargets: ["loop"],
          },
        },
      ]),
    ).toBeNull();
  });

  it("rejects a resetTargets entry that is not a graph node id (CONFIG)", () => {
    expect(
      compileErr([
        loopNode(),
        {
          id: "human",
          type: "human",
          finish: { human: { decisions: ["approve", "rework"] } },
          transitions: { approve: "done", rework: "loop" },
          rework: {
            allowedTargets: ["loop"],
            workspacePolicies: ["keep"],
            maxLoops: 2,
            resetTargets: ["ghost"],
          },
        },
      ]),
    ).toBe("CONFIG");
  });

  it("rejects a resetTargets entry that is not a rework-loop node (CONFIG)", () => {
    expect(
      compileErr([
        // "loop" leads forward to "plain" (a non-rework node) so the target is
        // reachable — isolating the not-a-loop-node failure.
        loopNode({ transitions: { success: "plain" } }),
        {
          id: "plain",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "done" },
        },
        {
          id: "human",
          type: "human",
          finish: { human: { decisions: ["approve", "rework"] } },
          transitions: { approve: "done", rework: "loop" },
          rework: {
            allowedTargets: ["loop"],
            workspacePolicies: ["keep"],
            maxLoops: 2,
            resetTargets: ["plain"],
          },
        },
      ]),
    ).toBe("CONFIG");
  });

  it("rejects a resetTargets loop node unreachable from rework.allowedTargets (CONFIG)", () => {
    expect(
      compileErr([
        loopNode(), // loop -> done; does NOT reach "island"
        {
          id: "island",
          type: "ai_coding",
          action: { prompt: "y" },
          transitions: { success: "done" },
          rework: {
            allowedTargets: ["island"],
            workspacePolicies: ["keep"],
            maxLoops: 2,
            commentsVar: "c",
          },
        },
        {
          id: "human",
          type: "human",
          finish: { human: { decisions: ["approve", "rework"] } },
          transitions: { approve: "done", rework: "loop" },
          rework: {
            allowedTargets: ["loop"],
            workspacePolicies: ["keep"],
            maxLoops: 2,
            resetTargets: ["island"],
          },
        },
      ]),
    ).toBe("CONFIG");
  });
});
