// RED (M15 Phase 1 §Task 3): Reject blocking human_review gates at manifest validation.
//
// Frozen contract from docs/system-analytics/readiness.md §Edge cases:
// - A blocking `human_review` gate MUST be rejected at `validateGraphManifest` with
//   `MaisterError("CONFIG")`
// - Advisory `human_review` gates are permitted
// - Blocking human_review would deadlock promotion (executor always records it as `skipped`)

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { loadFlowManifest } from "@/lib/config";
import { isMaisterError } from "@/lib/errors";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "config-human-review-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeFixture(name: string, content: string): Promise<string> {
  const path = join(workDir, name);

  await writeFile(path, content, "utf8");

  return path;
}

type GraphManifest = {
  schemaVersion: number;
  name: string;
  compat: { engine_min: string };
  nodes: Array<Record<string, unknown>>;
};

function baseGraphManifest(): GraphManifest {
  return {
    schemaVersion: 1,
    name: "test-flow",
    compat: { engine_min: "1.2.0" },
    nodes: [
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "/test" },
        transitions: { success: "review" },
        pre_finish: {
          gates: [],
        },
      },
      {
        id: "review",
        type: "human",
        finish: { human: { decisions: ["approve", "rework"] } },
        transitions: { approve: "done", rework: "implement" },
        rework: {
          allowedTargets: ["implement"],
          workspacePolicies: ["keep"],
          maxLoops: 3,
        },
        pre_finish: {
          gates: [],
        },
      },
    ],
  };
}

async function writeGraph(
  name: string,
  mutate: (m: GraphManifest) => void = () => {},
): Promise<string> {
  const m = structuredClone(baseGraphManifest());

  mutate(m);

  return writeFixture(name, stringifyYaml(m));
}

describe("validateGraphManifest — human_review gate blocking rejection (M15 §Task 3)", () => {
  it("rejects a human_review gate with mode: blocking", async () => {
    const path = await writeGraph("blocking-human-review.yaml", (m) => {
      (m.nodes[0].pre_finish as any).gates = [
        {
          id: "human_review_gate",
          kind: "human_review",
          mode: "blocking",
        },
      ];
    });

    let caught: unknown;

    try {
      await loadFlowManifest(path);
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as any).code).toBe("CONFIG");
    const msg = caught instanceof Error ? caught.message : "";

    expect(msg).toMatch(/human_review.*blocking|blocking.*human_review/i);
  });

  it("permits a human_review gate with mode: advisory", async () => {
    const path = await writeGraph("advisory-human-review.yaml", (m) => {
      (m.nodes[0].pre_finish as any).gates = [
        {
          id: "human_review_gate",
          kind: "human_review",
          mode: "advisory",
        },
      ];
    });

    let manifest: unknown;
    let caught: unknown;

    try {
      manifest = await loadFlowManifest(path);
    } catch (e) {
      caught = e;
    }

    // Should NOT throw
    expect(caught).toBeUndefined();
    expect(manifest).toBeDefined();
    if (manifest && typeof manifest === "object" && "nodes" in manifest) {
      const nodes = (
        manifest as { nodes?: Array<{ pre_finish?: { gates?: unknown[] } }> }
      ).nodes;

      if (
        nodes &&
        nodes[0] &&
        nodes[0].pre_finish &&
        nodes[0].pre_finish.gates
      ) {
        expect(nodes[0].pre_finish.gates).toHaveLength(1);
      }
    }
  });

  it("permits a human_review gate when mode is omitted (defaults to blocking) — MUST still reject", async () => {
    const path = await writeGraph("human-review-default-mode.yaml", (m) => {
      (m.nodes[0].pre_finish as any).gates = [
        {
          id: "human_review_gate",
          kind: "human_review",
          // mode omitted — defaults to "blocking" per schema
        },
      ];
    });

    let caught: unknown;

    try {
      await loadFlowManifest(path);
    } catch (e) {
      caught = e;
    }

    // Should reject because the default mode is "blocking"
    expect(isMaisterError(caught)).toBe(true);
    expect((caught as any).code).toBe("CONFIG");
  });

  it("rejects multiple blocking human_review gates in the same node", async () => {
    const path = await writeGraph(
      "multiple-blocking-human-reviews.yaml",
      (m) => {
        (m.nodes[0].pre_finish as any).gates = [
          {
            id: "hr1",
            kind: "human_review",
            mode: "blocking",
          },
          {
            id: "hr2",
            kind: "human_review",
            mode: "blocking",
          },
        ];
      },
    );

    let caught: unknown;

    try {
      await loadFlowManifest(path);
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as any).code).toBe("CONFIG");
  });

  it("permits a mix of advisory human_review and other gate kinds", async () => {
    const path = await writeGraph(
      "mixed-gates-advisory-human-review.yaml",
      (m) => {
        (m.nodes[0].pre_finish as any).gates = [
          {
            id: "cmd_check",
            kind: "command_check",
            mode: "blocking",
            command: "test",
          },
          {
            id: "human_review",
            kind: "human_review",
            mode: "advisory",
          },
        ];
      },
    );

    let manifest: unknown;
    let caught: unknown;

    try {
      manifest = await loadFlowManifest(path);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeUndefined();
    expect(manifest).toBeDefined();
  });

  it("rejects when one of multiple gates is a blocking human_review", async () => {
    const path = await writeGraph(
      "mixed-gates-blocking-human-review.yaml",
      (m) => {
        (m.nodes[0].pre_finish as any).gates = [
          {
            id: "cmd_check",
            kind: "command_check",
            mode: "blocking",
            command: "test",
          },
          {
            id: "human_review",
            kind: "human_review",
            mode: "blocking",
          },
        ];
      },
    );

    let caught: unknown;

    try {
      await loadFlowManifest(path);
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as any).code).toBe("CONFIG");
  });
});
