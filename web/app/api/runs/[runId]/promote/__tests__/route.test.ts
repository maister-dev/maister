import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAssignment,
  ensureUserActor,
  findActiveAssignmentForRun,
  systemCloseActiveAssignmentsForRun,
} from "@/lib/assignments/service";
import {
  runs as runsTable,
  scratchRuns as scratchRunsTable,
  workspaces as workspacesTable,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { assertEvidenceReady } from "@/lib/flows/graph/evidence-readiness";
import { branchExists, promoteLocalMerge } from "@/lib/worktree";

type Row = Record<string, unknown>;
type Tables = {
  runs: Row[];
  scratch_runs: Row[];
  workspaces: Row[];
};
type FakeDb = {
  select: () => ReturnType<typeof selectChain>;
  update: (table: unknown) => ReturnType<typeof updateChain>;
  execute: () => Promise<undefined>;
  transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
};

const dbState: { tables: Tables } = {
  tables: { runs: [], scratch_runs: [], workspaces: [] },
};

function tableOf(t: unknown): keyof Tables {
  if (t === runsTable) return "runs";
  if (t === scratchRunsTable) return "scratch_runs";
  if (t === workspacesTable) return "workspaces";
  throw new Error("unknown table");
}

// The durable promotion claim (M18 Phase 2) locks the workspace with `SELECT …
// FOR UPDATE`, so the select chain must resolve whether the caller terminates on
// `.where(...)` OR chains `.where(...).for("update")`.
const selectChain = () => ({
  from: (table: unknown) => {
    const rows = dbState.tables[tableOf(table)];
    const whereResult = {
      for: async (_mode: string) => rows,
      then: (resolve: (value: Row[]) => unknown) => resolve(rows),
    };

    return {
      where: () => whereResult,
    };
  },
});

const updateChain = (table: unknown) => ({
  set: (vals: Row) => ({
    where: async () => {
      for (const row of dbState.tables[tableOf(table)]) {
        Object.assign(row, vals);
      }
    },
  }),
});

const fakeDb: FakeDb = {
  select: selectChain,
  update: updateChain,
  execute: async () => undefined,
  transaction: async <T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> =>
    fn(fakeDb),
};

vi.mock("@/lib/db/client", () => ({
  getDb: () => fakeDb,
}));

vi.mock("@/lib/flows/graph/evidence-readiness", () => ({
  assertEvidenceReady: vi.fn(async () => ({ ready: true, reasons: [] })),
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "user-1",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  })),
  requireProjectAction: vi.fn(async () => ({
    user: {
      id: "user-1",
      role: "member",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "member",
  })),
}));

vi.mock("@/lib/worktree", () => ({
  branchExists: vi.fn(async () => true),
  promoteLocalMerge: vi.fn(async () => "def5678"),
  resolveBaseCommit: vi.fn(async () => "tip00000"),
}));

vi.mock("@/lib/assignments/service", () => ({
  createAssignment: vi.fn(async () => ({ id: "assignment-1" })),
  ensureUserActor: vi.fn(async () => ({ id: "actor-1" })),
  findActiveAssignmentForRun: vi.fn(async () => null),
  systemCloseActiveAssignmentsForRun: vi.fn(async () => []),
}));

vi.mock("@/lib/flows/graph/evidence-readiness", () => ({
  assertEvidenceReady: vi.fn(async () => ({ ready: true, reasons: [] })),
}));

function seedScratchRun(
  overrides: Partial<{
    runKind: "flow" | "scratch";
    dialogStatus: string;
    removedAt: Date | null;
    targetBranch: string | null;
  }> = {},
): string {
  const runId = "run-promote";

  dbState.tables.runs.push({
    id: runId,
    runKind: overrides.runKind ?? "scratch",
    projectId: "project-1",
    status: "Review",
    acpSessionId: "acp-1",
    currentStepId: "scratch-dialog",
    endedAt: null,
  });
  if ((overrides.runKind ?? "scratch") === "scratch") {
    dbState.tables.scratch_runs.push({
      runId,
      projectId: "project-1",
      baseBranch: "main",
      baseCommit: "abc1234",
      targetBranch: overrides.targetBranch ?? null,
      dialogStatus: overrides.dialogStatus ?? "Review",
      supervisorSessionId: null,
      updatedAt: null,
    });
  }
  dbState.tables.workspaces.push({
    id: "workspace-1",
    runId,
    projectId: "project-1",
    branch: "scratch/demo",
    parentRepoPath: "/repos/demo",
    removedAt: overrides.removedAt ?? null,
    baseBranch: "main",
    baseCommit: "abc1234",
    targetBranch: "main",
    promotionMode: "local_merge",
    promotionState: "none",
    promotionClaimedAt: null,
    promotionAttemptId: null,
    promotionOwnerUserId: null,
    promotedAt: null,
    scheduledRemovalAt: null,
  });

  return runId;
}

async function invokePost(runId: string, body: unknown) {
  const { POST } = await import("../route");
  const req = new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  return POST(req, { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  dbState.tables = { runs: [], scratch_runs: [], workspaces: [] };
  vi.mocked(branchExists).mockReset();
  vi.mocked(branchExists).mockResolvedValue(true);
  vi.mocked(promoteLocalMerge).mockReset();
  vi.mocked(promoteLocalMerge).mockResolvedValue("def5678");
  vi.mocked(createAssignment).mockReset();
  vi.mocked(createAssignment).mockResolvedValue({ id: "assignment-1" } as any);
  vi.mocked(ensureUserActor).mockReset();
  vi.mocked(ensureUserActor).mockResolvedValue({ id: "actor-1" } as any);
  vi.mocked(findActiveAssignmentForRun).mockReset();
  vi.mocked(findActiveAssignmentForRun).mockResolvedValue(null);
  vi.mocked(systemCloseActiveAssignmentsForRun).mockReset();
  vi.mocked(systemCloseActiveAssignmentsForRun).mockResolvedValue([]);
  vi.mocked(assertEvidenceReady).mockReset();
  vi.mocked(assertEvidenceReady).mockResolvedValue({
    ready: true,
    reasons: [],
  });
});

describe("POST /api/runs/[runId]/promote", () => {
  it("local-merges the scratch branch and marks the scratch run Done", async () => {
    const runId = seedScratchRun();

    const res = await invokePost(runId, {
      mode: "local_merge",
      targetBranch: "main",
    });
    const body = (await res.json()) as { commit?: string };

    expect(res.status).toBe(200);
    expect(branchExists).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo",
      branch: "main",
    });
    expect(promoteLocalMerge).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo",
      sourceBranch: "scratch/demo",
      targetBranch: "main",
    });
    expect(body.commit).toBe("def5678");
    expect(dbState.tables.scratch_runs[0]).toMatchObject({
      dialogStatus: "Done",
      targetBranch: "main",
      supervisorSessionId: null,
    });
    expect(dbState.tables.runs[0]).toMatchObject({
      status: "Done",
      acpSessionId: null,
      currentStepId: null,
    });
    expect(dbState.tables.runs[0].endedAt).toBeInstanceOf(Date);
    expect(systemCloseActiveAssignmentsForRun).toHaveBeenCalledWith({
      db: fakeDb,
      runId,
      reason: "run promoted to Done",
    });
  });

  it("rejects a missing target branch before merge", async () => {
    const runId = seedScratchRun();

    vi.mocked(branchExists).mockResolvedValueOnce(false);

    const res = await invokePost(runId, {
      mode: "local_merge",
      targetBranch: "missing",
    });

    expect(res.status).toBe(409);
    expect(promoteLocalMerge).not.toHaveBeenCalled();
    expect(dbState.tables.scratch_runs[0].dialogStatus).toBe("Review");
  });

  it("rejects an existing target branch outside the scratch base policy", async () => {
    const runId = seedScratchRun();

    vi.mocked(branchExists).mockResolvedValueOnce(true);

    const res = await invokePost(runId, {
      mode: "local_merge",
      targetBranch: "production",
    });

    expect(res.status).toBe(409);
    expect(branchExists).not.toHaveBeenCalled();
    expect(promoteLocalMerge).not.toHaveBeenCalled();
    expect(dbState.tables.scratch_runs[0].dialogStatus).toBe("Review");
  });

  it("leaves the scratch run in Review when the merge conflicts", async () => {
    const runId = seedScratchRun();

    vi.mocked(promoteLocalMerge).mockRejectedValueOnce(
      new MaisterError("CONFLICT", "merge conflict"),
    );

    const res = await invokePost(runId, {
      mode: "local_merge",
      targetBranch: "main",
    });

    expect(res.status).toBe(409);
    expect(dbState.tables.scratch_runs[0].dialogStatus).toBe("Review");
    expect(dbState.tables.runs[0].status).toBe("Review");
    expect(findActiveAssignmentForRun).toHaveBeenCalledWith({
      db: fakeDb,
      runId,
      actionKinds: ["merge_conflict"],
    });
    expect(ensureUserActor).toHaveBeenCalledWith({
      db: fakeDb,
      projectId: "project-1",
      userId: "user-1",
      label: "user-1",
    });
    expect(createAssignment).toHaveBeenCalledWith({
      db: fakeDb,
      projectId: "project-1",
      runId,
      taskId: null,
      actionKind: "merge_conflict",
      roleRefs: [],
      title: "Resolve merge conflict into main",
      createdByActorId: "actor-1",
      branch: "scratch/demo",
      ref: "main",
    });
  });

  it("does not duplicate an active merge-conflict assignment on repeated conflict", async () => {
    const runId = seedScratchRun();

    vi.mocked(promoteLocalMerge).mockRejectedValueOnce(
      new MaisterError("CONFLICT", "merge conflict"),
    );
    vi.mocked(findActiveAssignmentForRun).mockResolvedValueOnce({
      id: "assignment-existing",
    } as any);

    const res = await invokePost(runId, {
      mode: "local_merge",
      targetBranch: "main",
    });

    expect(res.status).toBe(409);
    expect(findActiveAssignmentForRun).toHaveBeenCalledWith({
      db: fakeDb,
      runId,
      actionKinds: ["merge_conflict"],
    });
    expect(ensureUserActor).not.toHaveBeenCalled();
    expect(createAssignment).not.toHaveBeenCalled();
  });

  // The route now serves flow runs too (M18 Phase 2): a flow run dispatches into
  // the shared promoteRun service rather than being rejected on a kind guard.
  // This asserts the dispatch genuinely engages — the flow path resolves the
  // target, runs the merge, and flips the run to Done. (The full flow contract —
  // readiness, drift, durable claim, two-racer — is covered by
  // promote-flow.integration.test.ts and promote-service.test.ts.)
  // reviewedTargetCommit matches the mocked live target HEAD, so there is no
  // drift; the target always resolves (proving it exists) regardless.
  it("dispatches a flow run through the shared promotion service to Done", async () => {
    const runId = seedScratchRun({ runKind: "flow" });

    const res = await invokePost(runId, {
      mode: "local_merge",
      targetBranch: "main",
      reviewedTargetCommit: "tip00000",
    });

    expect(res.status).toBe(200);
    expect(promoteLocalMerge).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo",
      sourceBranch: "scratch/demo",
      targetBranch: "main",
    });
    expect(dbState.tables.runs[0].status).toBe("Done");
    expect(dbState.tables.workspaces[0].promotionState).toBe("done");
  });

  it("rejects promotion before the scratch run reaches Review", async () => {
    const runId = seedScratchRun({ dialogStatus: "Running" });

    const res = await invokePost(runId, {
      mode: "local_merge",
      targetBranch: "main",
    });

    expect(res.status).toBe(409);
    expect(promoteLocalMerge).not.toHaveBeenCalled();
  });

  // M18 Phase 3: PR mode is implemented for flow runs (see promote-pr.test.ts +
  // route-status.test.ts). Scratch runs remain target-locked, local-merge-only,
  // so a scratch pull_request request is refused PRECONDITION → 409 (no longer
  // the Phase-2 CONFIG → 400).
  it("refuses pull_request mode for a scratch run (PRECONDITION → 409)", async () => {
    const runId = seedScratchRun();

    const res = await invokePost(runId, {
      mode: "pull_request",
      targetBranch: "main",
    });

    expect(res.status).toBe(409);
    expect(branchExists).not.toHaveBeenCalled();
    expect(promoteLocalMerge).not.toHaveBeenCalled();
  });

  // M15: merge-phase readiness guard for assertEvidenceReady

  describe("readiness guard (assertEvidenceReady)", () => {
    it("rejects promotion when assertEvidenceReady returns not-ready", async () => {
      const runId = seedScratchRun();

      vi.mocked(assertEvidenceReady).mockResolvedValueOnce({
        ready: false,
        reasons: ["blocking gate failed", "artifact missing"],
      });

      const res = await invokePost(runId, {
        mode: "local_merge",
        targetBranch: "main",
      });

      expect(res.status).toBe(409);
      expect(assertEvidenceReady).toHaveBeenCalledWith(runId, "merge", fakeDb);
      expect(promoteLocalMerge).not.toHaveBeenCalled();
      // Run stays in Review, not flipped to Done
      expect(dbState.tables.scratch_runs[0].dialogStatus).toBe("Review");
      expect(dbState.tables.runs[0].status).toBe("Review");
    });

    it("allows promotion when assertEvidenceReady returns ready", async () => {
      const runId = seedScratchRun();

      vi.mocked(assertEvidenceReady).mockResolvedValueOnce({
        ready: true,
        reasons: [],
      });

      const res = await invokePost(runId, {
        mode: "local_merge",
        targetBranch: "main",
      });

      expect(res.status).toBe(200);
      expect(assertEvidenceReady).toHaveBeenCalledWith(runId, "merge", fakeDb);
      expect(promoteLocalMerge).toHaveBeenCalledWith({
        projectRepoPath: "/repos/demo",
        sourceBranch: "scratch/demo",
        targetBranch: "main",
      });
      // Merge succeeded: run is Done
      expect(dbState.tables.scratch_runs[0].dialogStatus).toBe("Done");
      expect(dbState.tables.runs[0].status).toBe("Done");
    });

    it("vacuously ready scratch run (no gates) proceeds to merge", async () => {
      const runId = seedScratchRun();

      // Scratch runs have no flow gates, so assertEvidenceReady is vacuously ready.
      // Default mock returns ready: true.

      const res = await invokePost(runId, {
        mode: "local_merge",
        targetBranch: "main",
      });

      expect(res.status).toBe(200);
      expect(assertEvidenceReady).toHaveBeenCalledWith(runId, "merge", fakeDb);
      expect(promoteLocalMerge).toHaveBeenCalledWith({
        projectRepoPath: "/repos/demo",
        sourceBranch: "scratch/demo",
        targetBranch: "main",
      });
      expect(dbState.tables.scratch_runs[0].dialogStatus).toBe("Done");
      expect(dbState.tables.runs[0].status).toBe("Done");
    });
  });
});
