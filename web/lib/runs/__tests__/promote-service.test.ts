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
import {
  branchExists,
  promoteLocalMerge,
  resolveBaseCommit,
} from "@/lib/worktree";

// M18 Phase 2 — RED until `web/lib/runs/promote.ts` (the shared `promoteRun`
// service) lands. This is a UNIT test: the DB is a minimal drizzle-like fake
// (with `.for("update")` support so the durable claim's `SELECT … FOR UPDATE`
// resolves) and the git side-effects are spies. It encodes the PINNED §3.2
// durable-claim contract: terminal allow-list → readiness gate → target-drift
// gate → mint attempt token → CAS claiming → side-effect → finalize keyed on
// the attempt token.
//
// Concurrency (two-racer, stale-reclaim) is NOT exercised here — that requires
// real Postgres CAS and lives in the integration suite.

type Row = Record<string, unknown>;
type Tables = {
  runs: Row[];
  scratch_runs: Row[];
  workspaces: Row[];
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

// A select chain that resolves the table's rows whether the caller terminates
// on `.where(...)` OR chains `.where(...).for("update")` (the durable claim and
// finalize both lock the workspace row).
function selectChain() {
  const result = (table: unknown) => dbState.tables[tableOf(table)];

  return {
    from: (table: unknown) => {
      const whereResult = {
        for: async (_mode: string) => result(table),
        then: (resolve: (rows: Row[]) => unknown) => resolve(result(table)),
      };

      return {
        where: (_pred?: unknown) => whereResult,
      };
    },
  };
}

function updateChain(table: unknown) {
  return {
    set: (vals: Row) => ({
      where: async (_pred?: unknown) => {
        for (const row of dbState.tables[tableOf(table)]) {
          Object.assign(row, vals);
        }
      },
    }),
  };
}

const fakeDb: Record<string, unknown> = {
  select: selectChain,
  update: updateChain,
  execute: async () => undefined,
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn(fakeDb),
};

vi.mock("@/lib/db/client", () => ({
  getDb: () => fakeDb,
}));

vi.mock("@/lib/worktree", () => ({
  branchExists: vi.fn(async () => true),
  promoteLocalMerge: vi.fn(async () => "merged00"),
  resolveBaseCommit: vi.fn(async () => "tip00000"),
  resolveBaseRef: vi.fn(async () => "base0000"),
}));

vi.mock("@/lib/flows/graph/evidence-readiness", () => ({
  assertEvidenceReady: vi.fn(async () => ({ ready: true, reasons: [] })),
}));

vi.mock("@/lib/assignments/service", () => ({
  createAssignment: vi.fn(async () => ({ id: "assignment-1" })),
  ensureUserActor: vi.fn(async () => ({ id: "actor-1" })),
  findActiveAssignmentForRun: vi.fn(async () => null),
  systemCloseActiveAssignmentsForRun: vi.fn(async () => []),
}));

vi.mock("@/lib/instance-config", () => ({
  gcAgeDays: () => 7,
  runtimeRoot: () => "/tmp/maister",
  worktreesRoot: () => "/tmp/maister/worktrees",
}));

const sessionUser = {
  id: "user-1",
  name: "User One",
  email: "user1@test.com",
};

const authorize = vi.fn(async (_projectId: string) => undefined);

function ctx() {
  return { sessionUser, authorize };
}

function seedFlowRun(
  overrides: Partial<{
    status: string;
    promotionState: string;
    targetBranch: string | null;
    promotionMode: string | null;
    baseBranch: string | null;
    baseCommit: string | null;
    promotionAttemptId: string | null;
    promotionClaimedAt: Date | null;
  }> = {},
): string {
  const runId = "run-flow-promote";

  dbState.tables.runs.push({
    id: runId,
    runKind: "flow",
    projectId: "project-1",
    taskId: "task-1",
    status: overrides.status ?? "Review",
    acpSessionId: "acp-1",
    currentStepId: "review-node",
    endedAt: null,
  });
  dbState.tables.workspaces.push({
    id: "workspace-1",
    runId,
    projectId: "project-1",
    branch: "maister/flow-1",
    worktreePath: "/wt/flow-1",
    parentRepoPath: "/repos/demo",
    removedAt: null,
    baseBranch: overrides.baseBranch ?? "main",
    baseCommit: overrides.baseCommit ?? "base0000",
    targetBranch:
      overrides.targetBranch === undefined ? "main" : overrides.targetBranch,
    promotionMode:
      overrides.promotionMode === undefined
        ? "local_merge"
        : overrides.promotionMode,
    promotionState: overrides.promotionState ?? "none",
    promotionAttemptId: overrides.promotionAttemptId ?? null,
    promotionClaimedAt: overrides.promotionClaimedAt ?? null,
    promotionOwnerUserId: null,
    promotedAt: null,
    scheduledRemovalAt: null,
  });

  return runId;
}

function seedScratchRun(): string {
  const runId = "run-scratch-promote";

  dbState.tables.runs.push({
    id: runId,
    runKind: "scratch",
    projectId: "project-1",
    taskId: null,
    status: "Review",
    acpSessionId: "acp-2",
    currentStepId: "scratch-dialog",
    endedAt: null,
  });
  dbState.tables.scratch_runs.push({
    runId,
    projectId: "project-1",
    baseBranch: "main",
    baseCommit: "abc1234",
    targetBranch: null,
    dialogStatus: "Review",
    supervisorSessionId: null,
    updatedAt: null,
  });
  dbState.tables.workspaces.push({
    id: "workspace-2",
    runId,
    projectId: "project-1",
    branch: "scratch/demo",
    worktreePath: "/wt/scratch-demo",
    parentRepoPath: "/repos/demo",
    removedAt: null,
    baseBranch: "main",
    baseCommit: "abc1234",
    targetBranch: "main",
    promotionMode: "local_merge",
    promotionState: "none",
    promotionAttemptId: null,
    promotionClaimedAt: null,
    promotionOwnerUserId: null,
    promotedAt: null,
    scheduledRemovalAt: null,
  });

  return runId;
}

async function callPromote(runId: string, input: Record<string, unknown>) {
  const { promoteRun } = await import("../promote");

  return promoteRun(runId, input as never, ctx() as never);
}

async function expectMaisterCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ code });
}

beforeEach(() => {
  dbState.tables = { runs: [], scratch_runs: [], workspaces: [] };
  vi.mocked(branchExists).mockReset().mockResolvedValue(true);
  vi.mocked(promoteLocalMerge).mockReset().mockResolvedValue("merged00");
  vi.mocked(resolveBaseCommit).mockReset().mockResolvedValue("tip00000");
  vi.mocked(assertEvidenceReady)
    .mockReset()
    .mockResolvedValue({ ready: true, reasons: [] });
  vi.mocked(createAssignment)
    .mockReset()
    .mockResolvedValue({ id: "assignment-1" } as never);
  vi.mocked(ensureUserActor)
    .mockReset()
    .mockResolvedValue({ id: "actor-1" } as never);
  vi.mocked(findActiveAssignmentForRun).mockReset().mockResolvedValue(null);
  vi.mocked(systemCloseActiveAssignmentsForRun).mockReset().mockResolvedValue(
    [],
  );
  authorize.mockReset().mockResolvedValue(undefined);
});

describe("promoteRun — flow terminal allow-list", () => {
  it("rejects a non-Review flow run with PRECONDITION and never touches git", async () => {
    const runId = seedFlowRun({ status: "Running" });

    await expectMaisterCode(
      callPromote(runId, {
        mode: "local_merge",
        reviewedTargetCommit: "tip00000",
      }),
      "PRECONDITION",
    );

    expect(promoteLocalMerge).not.toHaveBeenCalled();
    expect(branchExists).not.toHaveBeenCalled();
    // No claim minted on a guard failure.
    expect(dbState.tables.workspaces[0].promotionState).toBe("none");
    expect(dbState.tables.runs[0].status).toBe("Running");
  });

  it("rejects an already-Done flow run (idempotent re-promote) with PRECONDITION", async () => {
    const runId = seedFlowRun({ status: "Done", promotionState: "done" });

    await expectMaisterCode(
      callPromote(runId, {
        mode: "local_merge",
        reviewedTargetCommit: "tip00000",
      }),
      "PRECONDITION",
    );

    expect(promoteLocalMerge).not.toHaveBeenCalled();
  });
});

describe("promoteRun — promote-time readiness gate (flow)", () => {
  it("refuses with PRECONDITION when evidence is not ready and never calls git", async () => {
    const runId = seedFlowRun();

    vi.mocked(assertEvidenceReady).mockResolvedValueOnce({
      ready: false,
      reasons: ["blocking gate failed"],
    });

    await expectMaisterCode(
      callPromote(runId, {
        mode: "local_merge",
        reviewedTargetCommit: "tip00000",
      }),
      "PRECONDITION",
    );

    expect(assertEvidenceReady).toHaveBeenCalledWith(
      runId,
      "review",
      expect.anything(),
    );
    expect(promoteLocalMerge).not.toHaveBeenCalled();
    // No claim minted: the readiness refusal precedes the CAS.
    expect(dbState.tables.workspaces[0].promotionState).toBe("none");
    expect(dbState.tables.runs[0].status).toBe("Review");
  });
});

describe("promoteRun — target-drift gate (flow, Codex F6)", () => {
  it("refuses with PRECONDITION when reviewedTargetCommit != live target HEAD, no git", async () => {
    const runId = seedFlowRun();

    vi.mocked(resolveBaseCommit).mockResolvedValue("advanced");

    await expectMaisterCode(
      callPromote(runId, {
        mode: "local_merge",
        reviewedTargetCommit: "stale000",
      }),
      "PRECONDITION",
    );

    expect(promoteLocalMerge).not.toHaveBeenCalled();
    expect(dbState.tables.workspaces[0].promotionState).toBe("none");
  });

  it("allowTargetDrift:true bypasses the drift check and reaches the merge", async () => {
    const runId = seedFlowRun();

    vi.mocked(resolveBaseCommit).mockResolvedValue("advanced");

    const res = await callPromote(runId, {
      mode: "local_merge",
      reviewedTargetCommit: "stale000",
      allowTargetDrift: true,
    });

    expect(res.ok).toBe(true);
    expect(promoteLocalMerge).toHaveBeenCalledTimes(1);
    expect(dbState.tables.runs[0].status).toBe("Done");
  });

  it("refuses a flow run with PRECONDITION when reviewedTargetCommit is absent", async () => {
    const runId = seedFlowRun();

    await expectMaisterCode(
      callPromote(runId, { mode: "local_merge" }),
      "PRECONDITION",
    );

    expect(promoteLocalMerge).not.toHaveBeenCalled();
  });

  it("allowTargetDrift:true WITHOUT reviewedTargetCommit is still refused (never promote blind)", async () => {
    const runId = seedFlowRun();

    await expectMaisterCode(
      callPromote(runId, { mode: "local_merge", allowTargetDrift: true }),
      "PRECONDITION",
    );

    // The reviewed-SHA requirement precedes target resolution and the claim.
    expect(resolveBaseCommit).not.toHaveBeenCalled();
    expect(promoteLocalMerge).not.toHaveBeenCalled();
    expect(dbState.tables.workspaces[0].promotionState).toBe("none");
  });

  it("allowTargetDrift:true still validates target existence — a missing target is PRECONDITION, not a merge conflict", async () => {
    const runId = seedFlowRun();

    // A target that does not resolve to a commit (missing branch): the real
    // resolveBaseCommit throws PRECONDITION. This must surface as-is, BEFORE the
    // claim and BEFORE any merge — never as a misclassified merge conflict.
    vi.mocked(resolveBaseCommit).mockRejectedValue(
      new MaisterError(
        "PRECONDITION",
        "base ref does not resolve to a commit: main",
      ),
    );

    await expectMaisterCode(
      callPromote(runId, {
        mode: "local_merge",
        reviewedTargetCommit: "tip00000",
        allowTargetDrift: true,
      }),
      "PRECONDITION",
    );

    expect(promoteLocalMerge).not.toHaveBeenCalled();
    expect(createAssignment).not.toHaveBeenCalled();
    expect(dbState.tables.workspaces[0].promotionState).toBe("none");
  });
});

describe("promoteRun — finalize attempt-token mismatch (Codex F5)", () => {
  it("returns CONFLICT and writes NOTHING when the attempt token changes mid-flight", async () => {
    const runId = seedFlowRun();

    // Simulate a same-user stale reclaim re-minting promotion_attempt_id while
    // this attempt's side-effect (promoteLocalMerge) ran: the finalize tx will
    // SELECT a workspace whose promotion_attempt_id no longer matches the token
    // this attempt minted in step 1.
    vi.mocked(promoteLocalMerge).mockImplementationOnce(async () => {
      const ws = dbState.tables.workspaces[0];

      ws.promotionAttemptId = "reclaimed-by-other";
      ws.promotionState = "claiming";

      return "merged00";
    });

    await expectMaisterCode(
      callPromote(runId, {
        mode: "local_merge",
        reviewedTargetCommit: "tip00000",
      }),
      "CONFLICT",
    );

    // Superseded attempt finalizes nothing: no Done, run stays Review, no
    // promoted_at / failed write by THIS attempt.
    expect(dbState.tables.runs[0].status).toBe("Review");
    expect(dbState.tables.workspaces[0].promotedAt).toBeNull();
    expect(dbState.tables.workspaces[0].promotionState).not.toBe("done");
    expect(systemCloseActiveAssignmentsForRun).not.toHaveBeenCalled();
  });
});

describe("promoteRun — local_merge conflict (flow)", () => {
  it("creates a merge-conflict assignment, leaves the run Review, and marks promotion_state=failed", async () => {
    const runId = seedFlowRun();

    vi.mocked(promoteLocalMerge).mockRejectedValueOnce(
      new MaisterError("CONFLICT", "merge conflict"),
    );

    await expectMaisterCode(
      callPromote(runId, {
        mode: "local_merge",
        reviewedTargetCommit: "tip00000",
      }),
      "CONFLICT",
    );

    expect(createAssignment).toHaveBeenCalledWith(
      expect.objectContaining({
        actionKind: "merge_conflict",
        runId,
        branch: "maister/flow-1",
        ref: "main",
      }),
    );
    expect(dbState.tables.runs[0].status).toBe("Review");
    expect(dbState.tables.workspaces[0].promotionState).toBe("failed");
  });
});

describe("promoteRun — happy path (flow local_merge)", () => {
  it("promotes a Review flow run to Done and records the merge commit", async () => {
    const runId = seedFlowRun();

    const res = await callPromote(runId, {
      mode: "local_merge",
      reviewedTargetCommit: "tip00000",
    });

    expect(res).toMatchObject({
      ok: true,
      mode: "local_merge",
      commit: "merged00",
      pullRequestUrl: null,
    });
    expect(authorize).toHaveBeenCalledWith("project-1");
    expect(promoteLocalMerge).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo",
      sourceBranch: "maister/flow-1",
      targetBranch: "main",
    });
    expect(dbState.tables.runs[0]).toMatchObject({
      status: "Done",
      acpSessionId: null,
      currentStepId: null,
    });
    expect(dbState.tables.runs[0].endedAt).toBeInstanceOf(Date);
    expect(dbState.tables.workspaces[0].promotionState).toBe("done");
    expect(systemCloseActiveAssignmentsForRun).toHaveBeenCalled();
  });

  it("allows a flow target branch that differs from the base", async () => {
    const runId = seedFlowRun({ baseBranch: "main", targetBranch: "release" });

    const res = await callPromote(runId, {
      mode: "local_merge",
      targetBranch: "release",
      reviewedTargetCommit: "tip00000",
    });

    expect(res.ok).toBe(true);
    expect(promoteLocalMerge).toHaveBeenCalledWith(
      expect.objectContaining({ targetBranch: "release" }),
    );
  });
});

describe("promoteRun — scratch dispatch (behavior preserved)", () => {
  it("routes a scratch run through the scratch path: target locked to base, M15 merge-readiness gated, no drift", async () => {
    const runId = seedScratchRun();

    const res = await callPromote(runId, { mode: "local_merge" });

    expect(res.ok).toBe(true);
    // Scratch path runs the M15 merge-readiness gate (phase "merge", preserved
    // across the M18 refactor-to-service) but NOT the flow drift guard — the
    // target is locked to the scratch base branch.
    expect(assertEvidenceReady).toHaveBeenCalledWith(
      runId,
      "merge",
      expect.anything(),
    );
    expect(resolveBaseCommit).not.toHaveBeenCalled();
    // Target locked to the scratch base branch.
    expect(promoteLocalMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceBranch: "scratch/demo",
        targetBranch: "main",
      }),
    );
    expect(dbState.tables.scratch_runs[0].dialogStatus).toBe("Done");
    expect(dbState.tables.runs[0].status).toBe("Done");
  });

  it("refuses a not-ready scratch promotion (M15 merge-readiness guard, no claim)", async () => {
    const runId = seedScratchRun();

    vi.mocked(assertEvidenceReady).mockResolvedValueOnce({
      ready: false,
      reasons: ["merge-required artifact stale"],
    });

    await expectMaisterCode(
      callPromote(runId, { mode: "local_merge" }),
      "PRECONDITION",
    );

    expect(promoteLocalMerge).not.toHaveBeenCalled();
    expect(dbState.tables.workspaces[0].promotionState).toBe("none");
  });

  it("rejects a scratch promotion target outside the scratch base policy", async () => {
    const runId = seedScratchRun();

    await expectMaisterCode(
      callPromote(runId, { mode: "local_merge", targetBranch: "production" }),
      "PRECONDITION",
    );

    expect(promoteLocalMerge).not.toHaveBeenCalled();
  });
});

// Note: the `pull_request` mode contract (preflight → push → createOrUpdatePr →
// finalize, idempotency, crash-window, retryable-vs-config split) is exercised
// in promote-pr.test.ts, which carries the proper PR harness (project table +
// pr-adapter / pushBranch spies). The Phase-2 "PR refused as not-yet" case it
// replaced was removed when PR mode landed (M18 Phase 3).
