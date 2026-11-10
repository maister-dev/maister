import type { Run } from "@/lib/db/schema";
import type { CompiledNode } from "@/lib/flows/graph/compile";

import { readFile } from "node:fs/promises";

import { describe, expect, it, vi, beforeEach } from "vitest";

import { runs } from "@/lib/db/schema";
import { createHitlAssignmentForRun } from "@/lib/assignments/service";
import { atomicWriteJson } from "@/lib/atomic";

/**
 * T4 increment 2: form-collect graph node runtime handler `runFormCollect`.
 * RED — runFormCollect is not exported yet, so the import yields undefined and
 * every call throws. Mirrors the runReviewHuman (m17) harness; adds a partial
 * mock of @/lib/config so readAndValidateFormSchemaDoc returns a canned schema
 * without touching disk.
 */

// Capture INSERT values for assertion.
const capturedInserts: Array<Record<string, unknown>> = [];

const fixtureRun = {
  id: "run-1",
  projectId: "proj-1",
  companyId: null,
  taskId: null,
  status: "Running",
  currentStepId: "intake",
  flowVersion: "v1.0.0",
  budgetState: null,
  executionAssignmentId: null,
  flowDriverToken: null,
} satisfies Pick<
  Run,
  | "id"
  | "projectId"
  | "companyId"
  | "taskId"
  | "status"
  | "currentStepId"
  | "flowVersion"
  | "budgetState"
  | "executionAssignmentId"
  | "flowDriverToken"
>;

type MockRun = typeof fixtureRun;
type MockSelection = Promise<MockRun[]> & { for: () => Promise<MockRun[]> };

type MockDb = {
  insert: () => { values: (row: Record<string, unknown>) => Promise<void> };
  select: () => { from: (table: unknown) => { where: () => MockSelection } };
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
    from: (table) => ({
      where: () => {
        const rows = table === runs ? [fixtureRun] : [];

        return Object.assign(Promise.resolve(rows), { for: async () => rows });
      },
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

// Partial-mock @/lib/config so readAndValidateFormSchemaDoc returns a canned
// schema without touching disk, WITHOUT dropping the module's other exports.
vi.mock("@/lib/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/config")>();

  return {
    ...real,
    readAndValidateFormSchemaDoc: vi.fn(async () => ({
      schemaVersion: 1,
      fields: [{ name: "tests", type: "select", options: ["yes", "no"] }],
    })),
    validateFormSchemaVersion: vi.fn(() => {}),
  };
});

// Module-level fs mock: default to ENOENT (first-visit path). The resume test
// overrides readFile per-call with vi.mocked(readFile).mockResolvedValueOnce.
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

/** Build a minimal CompiledNode for a form node. */
function makeFormNode(): CompiledNode {
  return {
    id: "intake",
    nodeType: "form",
    source: {
      kind: "node",

      node: {} as any,
    },
    transitions: { success: "plan" },
    gates: [],
    settings: undefined,
    retrySafe: false,
  };
}

// Import after mocks are registered.
const { runFormCollect } = await import("@/lib/flows/graph/runner-graph");

/** Minimal LoadedRun stub for runFormCollect. */

const makeLoaded = (runId = "run-1"): any => ({
  run: { ...fixtureRun, id: runId },
  projectSlug: "test-project",
  flowInstallPath: "/tmp/flow",
});

const baseCtx = {
  runtimeRoot: "/tmp/root",
  db: mockDb,
};

describe("runFormCollect (graph) — T4 form-collect node", () => {
  beforeEach(() => {
    capturedInserts.length = 0;
    vi.clearAllMocks();
  });

  it("first visit creates a kind:'form' HITL (fs reads ENOENT → first-visit path)", async () => {
    const node = makeFormNode();

    const result = await runFormCollect(
      node,
      makeLoaded(),
      {
        form_schema: "./schemas/intake.json",
        roles: ["reviewer"],
        criticality: "high",
      },
      baseCtx,
    );

    const inserted = capturedInserts.find((r) => r.kind === "form");

    expect(inserted).toBeDefined();
    expect(inserted?.criticality).toBe("high");

    expect(createHitlAssignmentForRun).toHaveBeenCalledWith(
      expect.objectContaining({
        actionKind: "form",
        roleRefs: ["reviewer"],
      }),
    );

    expect(atomicWriteJson).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "form" }),
    );

    expect(result.needsInput).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("inserts criticality: null when settings omit criticality", async () => {
    const node = makeFormNode();

    await runFormCollect(node, makeLoaded(), { form_schema: "x" }, baseCtx);

    const inserted = capturedInserts.find((r) => r.kind === "form");

    expect(inserted?.criticality).toBeNull();
  });

  it("resume returns submitted vars, no decision (input artifact present)", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(
      JSON.stringify({ tests: "yes", logging: "verbose" }),
    );

    const node = makeFormNode();

    const result = await runFormCollect(
      node,
      makeLoaded(),
      { form_schema: "./schemas/intake.json" },
      baseCtx,
    );

    expect(result.ok).toBe(true);
    expect(result.needsInput).toBe(false);
    expect(result.vars).toEqual({ tests: "yes", logging: "verbose" });
    expect(result.decision).toBeUndefined();

    // No HITL insert on resume.
    expect(capturedInserts.find((r) => r.kind === "form")).toBeUndefined();
  });
});
