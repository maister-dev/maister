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
import { readWorktreeProvenanceForPromotion } from "@/lib/worktree-provenance";
import {
  branchExists,
  deliveryCommitStats,
  deliveryHistoryStats,
  findTargetMergeByRunId,
  GitPushRejectedError,
  promoteLocalMerge,
  promoteRebaseMerge,
  pushBranch,
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
  insert: () => ({ values: async () => undefined }),
  execute: async () => undefined,
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn(fakeDb),
};

vi.mock("@/lib/db/client", () => ({
  getDb: () => fakeDb,
}));

// Pins the finalize-tx run.promoted/run.done emit pair — a dropped emit in
// promote.ts must fail here (the outbox row itself is integration-tested in
// lib/webhooks/__tests__).
const emitWebhookEventMock = vi.fn();

vi.mock("@/lib/webhooks/outbox", () => ({
  emitWebhookEvent: (...args: unknown[]) => emitWebhookEventMock(...args),
}));

vi.mock("@/lib/worktree", async () => ({
  // The REAL class: its `super("CONFLICT")` is the entire defect under test, and
  // `isMaisterError` is an `instanceof` check — a look-alike stub declared here
  // would be a different class and would not reproduce the routing at all.
  GitPushRejectedError: (
    await vi.importActual<typeof import("@/lib/worktree")>("@/lib/worktree")
  ).GitPushRejectedError,
  branchExists: vi.fn(async () => true),
  deliveryCommitStats: vi.fn(async () => ({
    files: 0,
    additions: 0,
    deletions: 0,
  })),
  deliveryHistoryStats: vi.fn(async () => ({
    files: 0,
    additions: 0,
    deletions: 0,
  })),
  headCommit: vi.fn(async () => "source-head-000"),
  findTargetMergeByRunId: vi.fn(async () => null),
  promoteLocalMerge: vi.fn(async () => "merged00"),
  promoteRebaseMerge: vi.fn(async () => "rebased00"),
  pushBranch: vi.fn(async () => undefined),
  resolveBaseCommit: vi.fn(async () => "tip00000"),
  resolveBaseRef: vi.fn(async () => "base0000"),
}));

vi.mock("@/lib/worktree-provenance", () => ({
  readWorktreeProvenanceForPromotion: vi.fn(async (worktreePath: string) => ({
    runId: worktreePath.includes("scratch")
      ? "run-scratch-promote"
      : worktreePath.includes("agent")
        ? "run-agent-promote"
        : "run-flow-promote",
  })),
}));

vi.mock("@/lib/flows/graph/evidence-readiness", () => ({
  assertEvidenceReady: vi.fn(async () => ({ ready: true, reasons: [] })),
}));

vi.mock("@/lib/experiments/status-sync", () => ({
  syncExperimentStatusForRun: vi.fn(async () => ({
    changed: false,
    experimentId: null,
  })),
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

// ADR-140 (Task 13): the ai_rebase_merge conflict branch dynamic-imports
// syncRunTarget to delegate to the AI resolver.
const syncTargetMock = vi.hoisted(() => ({
  // Takes its input, like the real one — otherwise the mock's call tuple types as
  // empty and the delegation input cannot be asserted at all.
  syncRunTarget: vi.fn(async (_input: Record<string, unknown>) => ({
    attemptId: "sync-att-1",
    outcome: "agent_launched" as const,
    behind: 1,
    pushed: false,
  })),
}));

vi.mock("@/lib/runs/sync-target", () => syncTargetMock);

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
    deliveryPolicySnapshot: Record<string, unknown> | null;
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
    deliveryPolicySnapshot: overrides.deliveryPolicySnapshot ?? null,
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

function seedAgentRun(): string {
  const runId = "run-agent-promote";

  dbState.tables.runs.push({
    id: runId,
    runKind: "agent",
    projectId: "project-1",
    taskId: null,
    status: "Review",
    agentId: "pkg:agent",
    acpSessionId: "acp-agent",
    currentStepId: "agent",
    endedAt: null,
    deliveryPolicySnapshot: null,
  });
  dbState.tables.workspaces.push({
    id: "workspace-agent",
    runId,
    projectId: "project-1",
    branch: "maister/agent-pkg-agent-12345678",
    worktreePath: "/wt/agent-demo",
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
  vi.mocked(deliveryHistoryStats).mockReset().mockResolvedValue({
    files: 0,
    additions: 0,
    deletions: 0,
  });
  vi.mocked(deliveryCommitStats).mockReset().mockResolvedValue({
    files: 0,
    additions: 0,
    deletions: 0,
  });
  vi.mocked(findTargetMergeByRunId).mockReset().mockResolvedValue(null);
  vi.mocked(promoteLocalMerge).mockReset().mockResolvedValue("merged00");
  vi.mocked(promoteRebaseMerge).mockReset().mockResolvedValue("rebased00");
  vi.mocked(pushBranch).mockReset().mockResolvedValue(undefined);
  vi.mocked(resolveBaseCommit).mockReset().mockResolvedValue("tip00000");
  vi.mocked(assertEvidenceReady)
    .mockReset()
    .mockResolvedValue({ ready: true, reasons: [] });
  vi.mocked(readWorktreeProvenanceForPromotion)
    .mockReset()
    .mockImplementation(async (worktreePath: string) => ({
      runId: worktreePath.includes("scratch")
        ? "run-scratch-promote"
        : worktreePath.includes("agent")
          ? "run-agent-promote"
          : "run-flow-promote",
    }));
  vi.mocked(createAssignment)
    .mockReset()
    .mockResolvedValue({ id: "assignment-1" } as never);
  vi.mocked(ensureUserActor)
    .mockReset()
    .mockResolvedValue({ id: "actor-1" } as never);
  vi.mocked(findActiveAssignmentForRun).mockReset().mockResolvedValue(null);
  vi.mocked(systemCloseActiveAssignmentsForRun)
    .mockReset()
    .mockResolvedValue([]);
  authorize.mockReset().mockResolvedValue(undefined);
  emitWebhookEventMock.mockClear();
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
    expect(emitWebhookEventMock).not.toHaveBeenCalled();
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
    expect(emitWebhookEventMock).not.toHaveBeenCalled();
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
      provenance: { runId: "run-flow-promote" },
    });
    expect(dbState.tables.runs[0]).toMatchObject({
      status: "Done",
      currentStepId: null,
      promotedHeadSha: "merged00",
      mergeCommitSha: "merged00",
      diffStat: { files: 0, additions: 0, deletions: 0 },
    });
    expect(dbState.tables.runs[0].endedAt).toBeInstanceOf(Date);
    expect(dbState.tables.workspaces[0].promotionState).toBe("done");
    expect(systemCloseActiveAssignmentsForRun).toHaveBeenCalled();

    // The finalize tx emits exactly run.promoted then run.done.
    expect(
      emitWebhookEventMock.mock.calls.map(
        (c) => (c[0] as { type: string }).type,
      ),
    ).toEqual(["run.promoted", "run.done"]);
    expect(emitWebhookEventMock.mock.calls[0][0]).toMatchObject({
      type: "run.promoted",
      runId,
      data: { mode: "local_merge", target: "main", pullRequestUrl: null },
    });
  });

  it("recovers a stamped target merge without creating a second merge", async () => {
    const runId = seedFlowRun();

    vi.mocked(findTargetMergeByRunId).mockResolvedValueOnce("recovered00");
    vi.mocked(deliveryCommitStats).mockResolvedValueOnce({
      files: 1,
      additions: 4,
      deletions: 2,
    });

    await expect(
      callPromote(runId, {
        mode: "local_merge",
        reviewedTargetCommit: "tip00000",
      }),
    ).resolves.toMatchObject({ ok: true, commit: "recovered00" });

    expect(promoteLocalMerge).not.toHaveBeenCalled();
    expect(deliveryCommitStats).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo",
      commit: "recovered00",
    });
    expect(dbState.tables.runs[0]).toMatchObject({
      promotedHeadSha: "recovered00",
      mergeCommitSha: "recovered00",
      diffStat: { files: 1, additions: 4, deletions: 2 },
    });
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

  it("refuses conflicting managed provenance before the target merge", async () => {
    const runId = seedFlowRun();

    vi.mocked(readWorktreeProvenanceForPromotion).mockResolvedValueOnce({
      runId: "another-run",
    });

    await expectMaisterCode(
      callPromote(runId, {
        mode: "local_merge",
        reviewedTargetCommit: "tip00000",
      }),
      "PRECONDITION",
    );

    expect(promoteLocalMerge).not.toHaveBeenCalled();
    expect(dbState.tables.workspaces[0].promotionState).toBe("failed");
  });

  it("preserves legacy flow promotion without manufacturing a recovery trailer", async () => {
    const runId = seedFlowRun();

    vi.mocked(readWorktreeProvenanceForPromotion).mockResolvedValueOnce(null);

    await expect(
      callPromote(runId, {
        mode: "local_merge",
        reviewedTargetCommit: "tip00000",
      }),
    ).resolves.toMatchObject({ ok: true, commit: "merged00" });

    expect(findTargetMergeByRunId).not.toHaveBeenCalled();
    expect(promoteLocalMerge).toHaveBeenCalledWith(
      expect.objectContaining({ provenance: undefined }),
    );
    expect(dbState.tables.runs[0]).toMatchObject({
      status: "Done",
      promotedHeadSha: "merged00",
      diffStat: { files: 0, additions: 0, deletions: 0 },
    });
    expect(dbState.tables.workspaces[0].promotionState).toBe("done");
  });

  it("fails a recognizable managed worktree with missing provenance and releases its claim", async () => {
    const runId = seedFlowRun();

    vi.mocked(readWorktreeProvenanceForPromotion).mockRejectedValueOnce(
      new MaisterError(
        "PRECONDITION",
        "managed provenance metadata is missing",
      ),
    );

    await expectMaisterCode(
      callPromote(runId, {
        mode: "local_merge",
        reviewedTargetCommit: "tip00000",
      }),
      "PRECONDITION",
    );

    expect(promoteLocalMerge).not.toHaveBeenCalled();
    expect(dbState.tables.workspaces[0].promotionState).toBe("failed");
  });

  it("pushes the target branch before Done when policy push is on_success", async () => {
    const runId = seedFlowRun({
      deliveryPolicySnapshot: {
        strategy: "merge",
        push: "on_success",
        trigger: "manual",
        targetBranch: "main",
      },
    });

    const res = await callPromote(runId, {
      reviewedTargetCommit: "tip00000",
    });

    expect(res).toMatchObject({
      ok: true,
      mode: "merge",
      deliveryPolicy: { push: "on_success" },
    });
    expect(pushBranch).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo",
      remote: "origin",
      branch: "main",
    });
    expect(dbState.tables.runs[0].status).toBe("Done");
  });

  it("promotes ai_rebase_merge through the rebase side-effect while preserving the response mode", async () => {
    const runId = seedFlowRun({
      deliveryPolicySnapshot: {
        strategy: "ai_rebase_merge",
        push: "never",
        trigger: "manual",
        targetBranch: "main",
      },
    });

    const res = await callPromote(runId, {
      reviewedTargetCommit: "tip00000",
    });

    expect(res).toMatchObject({
      ok: true,
      mode: "ai_rebase_merge",
      commit: "rebased00",
      pullRequestUrl: null,
      deliveryPolicy: { strategy: "ai_rebase_merge" },
    });
    expect(promoteLocalMerge).not.toHaveBeenCalled();
    expect(promoteRebaseMerge).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo",
      sourceBranch: "maister/flow-1",
      targetBranch: "main",
      worktreePath: "/wt/flow-1",
    });
    expect(pushBranch).not.toHaveBeenCalled();
    expect(dbState.tables.workspaces[0]).toMatchObject({
      promotionMode: "rebase_merge",
      promotionState: "done",
    });
  });

  // C1: `GitPushRejectedError` extends MaisterError with `super("CONFLICT")`, so
  // while the target push sat inside the merge's catch, a merely REJECTED PUSH —
  // of an already-landed merge — was read as "the rebase conflicted" and spawned
  // an AI resolver for a conflict that does not exist, burning a slot and tokens,
  // and answered `ok: true` for a landed-but-unpushed merge.
  it("does NOT spawn a resolver when the TARGET PUSH is rejected (ai_rebase_merge)", async () => {
    const runId = seedFlowRun({
      deliveryPolicySnapshot: {
        strategy: "ai_rebase_merge",
        // The push must actually run — that is the whole window.
        push: "on_success",
        trigger: "manual",
        targetBranch: "main",
      },
    });

    // The merge LANDS; only the follow-up push is refused.
    vi.mocked(pushBranch).mockRejectedValueOnce(
      new GitPushRejectedError("push rejected (non-fast-forward)"),
    );
    syncTargetMock.syncRunTarget.mockClear();

    await expect(
      callPromote(runId, { reviewedTargetCommit: "tip00000" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // The contract: a push rejection is NOT a rebase conflict.
    expect(syncTargetMock.syncRunTarget).not.toHaveBeenCalled();
    expect(createAssignment).not.toHaveBeenCalled();
    // The promotion degraded to manual — never silently reported as done.
    expect(dbState.tables.workspaces[0]).toMatchObject({
      promotionState: "failed",
    });
  });

  it("delegates an ai_rebase_merge conflict to the AI sync resolver (ADR-140 Task 13)", async () => {
    const runId = seedFlowRun({
      deliveryPolicySnapshot: {
        strategy: "ai_rebase_merge",
        push: "never",
        trigger: "manual",
        targetBranch: "main",
      },
    });

    vi.mocked(promoteRebaseMerge).mockRejectedValueOnce(
      new MaisterError("CONFLICT", "rebase conflict"),
    );
    syncTargetMock.syncRunTarget.mockClear();

    const res = await callPromote(runId, {
      reviewedTargetCommit: "tip00000",
    });

    // The conflict is delegated to the resolver, NOT a merge-conflict assignment.
    expect(res).toMatchObject({
      ok: true,
      mode: "ai_rebase_merge",
      resolverLaunched: true,
    });
    // #C6: this used to be an objectContaining that named only runId/strategy/agent,
    // so autoFinalize, push, the actor and the injected db were all unpinned —
    // exactly the fields that were wrong. Assert the WHOLE delegation input.
    expect(syncTargetMock.syncRunTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        strategy: "rebase",
        agent: true,
        // The resolver must not push: `ai_rebase_merge` finalizes by merging
        // locally, and this policy is push:"never".
        push: false,
        // Default OFF — the two-step Review is the default contract.
        autoFinalize: false,
        // A human promote records a real user on the force-push ledger.
        actor: { type: "user", id: "user-1" },
      }),
    );
    // The injected db must reach the delegation; omitting it silently fell back
    // to getDb() and escaped this test's seam entirely.
    expect(syncTargetMock.syncRunTarget.mock.calls[0][0]).toHaveProperty("db");
    expect(createAssignment).not.toHaveBeenCalled();
    // The promotion claim is released before the resolver runs (no crash window).
    expect(dbState.tables.workspaces[0]).toMatchObject({
      promotionState: "failed",
    });
  });

  it("(#C6) rides autoFinalize:true through to the resolver", async () => {
    const runId = seedFlowRun({
      deliveryPolicySnapshot: {
        strategy: "ai_rebase_merge",
        push: "never",
        trigger: "manual",
        targetBranch: "main",
      },
    });

    vi.mocked(promoteRebaseMerge).mockRejectedValueOnce(
      new MaisterError("CONFLICT", "rebase conflict"),
    );
    syncTargetMock.syncRunTarget.mockClear();

    await callPromote(runId, {
      reviewedTargetCommit: "tip00000",
      autoFinalize: true,
    });

    expect(syncTargetMock.syncRunTarget).toHaveBeenCalledWith(
      expect.objectContaining({ autoFinalize: true }),
    );
  });

  // #6: `resolvedMode` comes from the project delivery policy, not `input.mode`,
  // so a SYSTEM promote (the ADR-126 cron lane) reaches this delegation too — and
  // its sessionUser.id is the synthetic `auto-promotion:<projectId>`. Recording
  // that as a user invented a human on the ledger of a force-push.
  it("(#6) records the canonical actor, not the placeholder sessionUser, for a system promote", async () => {
    const runId = seedFlowRun({
      deliveryPolicySnapshot: {
        strategy: "ai_rebase_merge",
        push: "never",
        trigger: "manual",
        targetBranch: "main",
      },
    });

    vi.mocked(promoteRebaseMerge).mockRejectedValueOnce(
      new MaisterError("CONFLICT", "rebase conflict"),
    );
    syncTargetMock.syncRunTarget.mockClear();

    const { promoteRun } = await import("../promote");

    await promoteRun(
      runId,
      { reviewedTargetCommit: "tip00000" } as never,
      {
        sessionUser: { id: "auto-promotion:proj-1" },
        authorize,
        actor: { kind: "system" },
      } as never,
    );

    expect(syncTargetMock.syncRunTarget).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { type: "system", id: null } }),
    );
  });

  it("(#6) records an agent actor by its agent id", async () => {
    const runId = seedFlowRun({
      deliveryPolicySnapshot: {
        strategy: "ai_rebase_merge",
        push: "never",
        trigger: "manual",
        targetBranch: "main",
      },
    });

    vi.mocked(promoteRebaseMerge).mockRejectedValueOnce(
      new MaisterError("CONFLICT", "rebase conflict"),
    );
    syncTargetMock.syncRunTarget.mockClear();

    const { promoteRun } = await import("../promote");

    await promoteRun(
      runId,
      { reviewedTargetCommit: "tip00000" } as never,
      {
        sessionUser: { id: "orchestrator:proj-1" },
        authorize,
        actor: { kind: "agent", agentId: "agent-7" },
      } as never,
    );

    expect(syncTargetMock.syncRunTarget).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { type: "agent", id: "agent-7" } }),
    );
  });

  it("promotes a Review flow run through rebase_merge", async () => {
    const runId = seedFlowRun({ promotionMode: "rebase_merge" });

    const res = await callPromote(runId, {
      mode: "rebase_merge",
      reviewedTargetCommit: "tip00000",
    });

    expect(res).toMatchObject({
      ok: true,
      mode: "rebase_merge",
      commit: "rebased00",
      pullRequestUrl: null,
    });
    expect(promoteRebaseMerge).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo",
      sourceBranch: "maister/flow-1",
      targetBranch: "main",
      worktreePath: "/wt/flow-1",
    });
    expect(promoteLocalMerge).not.toHaveBeenCalled();
    expect(dbState.tables.runs[0].status).toBe("Done");
    expect(emitWebhookEventMock.mock.calls[0][0]).toMatchObject({
      type: "run.promoted",
      runId,
      data: { mode: "rebase_merge", target: "main", pullRequestUrl: null },
    });
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
    expect(resolveBaseCommit).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo",
      baseRef: "main",
    });
    // Target locked to the scratch base branch.
    expect(promoteLocalMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceBranch: "scratch/demo",
        targetBranch: "main",
      }),
    );
    expect(dbState.tables.scratch_runs[0].dialogStatus).toBe("Done");
    expect(dbState.tables.runs[0]).toMatchObject({
      status: "Done",
      promotedHeadSha: "merged00",
      mergeCommitSha: "merged00",
      diffStat: { files: 0, additions: 0, deletions: 0 },
    });

    // The scratch finalize tx emits the same run.promoted + run.done pair.
    expect(
      emitWebhookEventMock.mock.calls.map(
        (c) => (c[0] as { type: string }).type,
      ),
    ).toEqual(["run.promoted", "run.done"]);
  });

  it("preserves legacy scratch promotion without manufacturing a recovery trailer", async () => {
    const runId = seedScratchRun();

    vi.mocked(readWorktreeProvenanceForPromotion).mockResolvedValueOnce(null);

    await expect(
      callPromote(runId, { mode: "local_merge" }),
    ).resolves.toMatchObject({
      ok: true,
      commit: "merged00",
    });

    expect(findTargetMergeByRunId).not.toHaveBeenCalled();
    expect(promoteLocalMerge).toHaveBeenCalledWith(
      expect.objectContaining({ provenance: undefined }),
    );
    expect(dbState.tables.workspaces[0].promotionState).toBe("done");
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

  it("rejects rebase_merge for scratch runs before touching git", async () => {
    const runId = seedScratchRun();

    await expectMaisterCode(
      callPromote(runId, { mode: "rebase_merge" }),
      "PRECONDITION",
    );

    expect(promoteRebaseMerge).not.toHaveBeenCalled();
    expect(promoteLocalMerge).not.toHaveBeenCalled();
    expect(dbState.tables.workspaces[0].promotionState).toBe("none");
  });
});

describe("promoteRun — agent worktree dispatch", () => {
  it("promotes a Review agent run through the workspace merge path", async () => {
    const runId = seedAgentRun();

    const res = await callPromote(runId, {
      deliveryPolicyOverride: {
        strategy: "merge",
        push: "never",
        trigger: "manual",
        targetBranch: "main",
      },
      targetBranch: "main",
      reviewedTargetCommit: "tip00000",
    });

    expect(res).toMatchObject({
      ok: true,
      mode: "merge",
      commit: "merged00",
      pullRequestUrl: null,
    });
    expect(assertEvidenceReady).not.toHaveBeenCalled();
    expect(promoteLocalMerge).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo",
      sourceBranch: "maister/agent-pkg-agent-12345678",
      targetBranch: "main",
      provenance: { runId: "run-agent-promote" },
    });
    expect(dbState.tables.runs[0]).toMatchObject({
      status: "Done",
      currentStepId: null,
    });
    expect(dbState.tables.workspaces[0].promotionState).toBe("done");
  });
});

// Note: the `pull_request` mode contract (preflight → push → createOrUpdatePr →
// finalize, idempotency, crash-window, retryable-vs-config split) is exercised
// in promote-pr.test.ts, which carries the proper PR harness (project table +
// pr-adapter / pushBranch spies). The Phase-2 "PR refused as not-yet" case it
// replaced was removed when PR mode landed (M18 Phase 3).
