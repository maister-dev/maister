import type { CompiledNode } from "@/lib/flows/graph/compile";

import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * M17 ADR-054: criticality creation-path tests for graph human_review nodes
 * Verify that criticality from node.settings is written ONCE at hitl_requests INSERT.
 */

// Capture INSERT values for assertion.
const capturedInserts: Array<Record<string, unknown>> = [];

type MockDb = {
  insert: () => { values: (row: Record<string, unknown>) => Promise<void> };
  select: () => { from: () => { where: () => Promise<[]> } };
  update: () => { set: () => { where: () => Promise<[]> } };
  transaction: <T>(fn: (tx: MockDb) => Promise<T>) => Promise<T>;
};

const mockDb: MockDb = {
  insert: () => ({
    values: (row: Record<string, unknown>) => {
      capturedInserts.push({ ...row });

      return Promise.resolve();
    },
  }),
  select: () => ({
    from: () => ({
      where: async () => [] as [],
    }),
  }),
  update: () => ({
    set: () => ({
      where: async () => [] as [],
    }),
  }),
  transaction: async <T>(fn: (tx: MockDb) => Promise<T>) => fn(mockDb),
};

vi.mock("@/lib/db/client", () => ({
  getDb: () => mockDb,
}));

vi.mock("@/lib/assignments/service", () => ({
  createHitlAssignmentForRun: vi.fn(async () => {}),
  systemCloseActiveAssignmentsForRun: vi.fn(async () => {}),
}));

vi.mock("@/lib/atomic", () => ({
  atomicWriteJson: vi.fn(async () => {}),
}));

// Make tryReadInputArtifact return null (no existing input → creation path).
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...real,
    access: vi.fn(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
    readFile: vi.fn(async (_p: unknown) => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
    stat: vi.fn(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
    unlink: vi.fn(async () => {}),
  };
});

/** Build a minimal CompiledNode for a human node with optional criticality. */
function makeHumanNode(
  criticality?: "low" | "medium" | "high" | "critical",
): CompiledNode {
  return {
    id: "review",
    nodeType: "human",
    source: {
      kind: "node",

      node: {} as any,
    },
    transitions: { approve: "done", rework: "implement" },
    gates: [],
    finishHuman: { decisions: ["approve", "rework"] },
    settings: criticality !== undefined ? { criticality } : undefined,
    retrySafe: false,
  };
}

// Import after mocks are registered.
const { runReviewHuman } = await import("@/lib/flows/graph/runner-graph");

/** Minimal LoadedRun stub for runReviewHuman. */

const makeLoaded = (runId = "run-1"): any => ({
  run: {
    id: runId,
    projectId: "proj-1",
    status: "Running",
    currentStepId: "review",
    flowVersion: "v1.0.0",
  },
  projectSlug: "test-project",
});

const baseCtx = {
  runtimeRoot: "/tmp/test-root",
  db: mockDb,
};

describe("runReviewHuman (graph) — M17 criticality field", () => {
  beforeEach(() => {
    capturedInserts.length = 0;
    vi.clearAllMocks();
  });

  it("writes criticality: 'high' from node.settings to hitl_requests row", async () => {
    const node = makeHumanNode("high");

    await runReviewHuman(node, makeLoaded(), "Review 'review'", baseCtx);

    const inserted = capturedInserts.find((r) => r.kind === "human");

    expect(inserted?.criticality).toBe("high");
  });

  it("writes criticality: 'medium' from node.settings to hitl_requests row", async () => {
    const node = makeHumanNode("medium");

    await runReviewHuman(node, makeLoaded(), "Review 'review'", baseCtx);

    const inserted = capturedInserts.find((r) => r.kind === "human");

    expect(inserted?.criticality).toBe("medium");
  });

  it("writes criticality: 'critical' from node.settings to hitl_requests row", async () => {
    const node = makeHumanNode("critical");

    await runReviewHuman(node, makeLoaded(), "Review 'review'", baseCtx);

    const inserted = capturedInserts.find((r) => r.kind === "human");

    expect(inserted?.criticality).toBe("critical");
  });

  it("writes NULL criticality when node.settings has no criticality field", async () => {
    const node = makeHumanNode(undefined);

    await runReviewHuman(node, makeLoaded(), "Review 'review'", baseCtx);

    const inserted = capturedInserts.find((r) => r.kind === "human");

    expect(inserted?.criticality).toBeNull();
  });

  it("criticality is persisted alongside decision allow-list at creation", async () => {
    const node = makeHumanNode("critical");

    await runReviewHuman(node, makeLoaded(), "Review 'review'", baseCtx);

    const inserted = capturedInserts.find((r) => r.kind === "human");

    expect(inserted?.criticality).toBe("critical");
    expect((inserted?.schema as any)?.allowedDecisions).toEqual([
      "approve",
      "rework",
    ]);
  });
});
