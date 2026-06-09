import { describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  archiveWorkbench,
  dropWorkbench,
  exportWorkbenchBranch,
  stopFlowWorkbench,
  type LifecycleContext,
  type WorkbenchLifecycleDeps,
} from "@/lib/workbench-lifecycle/service";

function context(over: Partial<LifecycleContext> = {}): LifecycleContext {
  return {
    project: {
      id: "project-1",
      mainBranch: "main",
    },
    run: {
      id: "run-1",
      projectId: "project-1",
      runKind: "flow",
      status: "Review",
      acpSessionId: "acp-1",
      currentStepId: "implement",
    },
    workspace: {
      id: "workspace-1",
      runId: "run-1",
      projectId: "project-1",
      branch: "maister/run-1",
      worktreePath: "/tmp/maister/worktrees/run-1",
      parentRepoPath: "/tmp/repo",
      removedAt: null,
      archivedBranch: null,
      archivedAt: null,
      baseBranch: "main",
      baseCommit: "abc1234",
    },
    ...over,
  };
}

function deps(ctx: LifecycleContext): WorkbenchLifecycleDeps {
  return {
    requireActiveSession: vi.fn(async () => undefined),
    loadContext: vi.fn(async () => ctx),
    authorize: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    deleteSession: vi.fn(async () => undefined),
    markStoppedAndCloseAssignments: vi.fn(async () => undefined),
    promoteNextPending: vi.fn(async () => undefined),
    preserveWorktree: vi.fn(async () => ({
      ok: true,
      archivedBranch: "maister/archive/run-1",
      archivedAt: new Date("2026-06-09T08:00:00.000Z"),
      snapshotted: true,
    })),
    recordArchive: vi.fn(async () => undefined),
    recordDrop: vi.fn(async () => undefined),
    removeOwnedWorktree: vi.fn(async () => undefined),
    worktreesRoot: vi.fn(() => "/tmp/maister/worktrees"),
    statusPorcelain: vi.fn(async () => ""),
    snapshotDirtyWorktree: vi.fn(async () => false),
    pushBranch: vi.fn(async () => undefined),
    claimLifecycleOperation: vi.fn(async () => ({
      attemptId: "lifecycle-attempt-1",
    })),
    finalizeLifecycleOperation: vi.fn(async () => undefined),
    listRemotes: vi.fn(async () => ["origin"]),
    headCommit: vi.fn(async () => "abc1234"),
    localBranchHead: vi.fn(async () => null),
    remoteBranchHead: vi.fn(async () => null),
    createBranchAtHead: vi.fn(async () => undefined),
  };
}

describe("workbench lifecycle service", () => {
  it("archive refuses live flow workbenches before preserving", async () => {
    const d = deps(context({ run: { ...context().run, status: "Running" } }));

    await expect(archiveWorkbench("run-1", { deps: d })).rejects.toThrow(
      MaisterError,
    );

    expect(d.preserveWorktree).not.toHaveBeenCalled();
    expect(d.recordArchive).not.toHaveBeenCalled();
  });

  it("archive records the archive branch only after preserve succeeds", async () => {
    const d = deps(context());

    const result = await archiveWorkbench("run-1", { deps: d });

    expect(result).toMatchObject({
      ok: true,
      archived: true,
      archivedBranch: "maister/archive/run-1",
      snapshotted: true,
    });
    expect(d.preserveWorktree).toHaveBeenCalledWith({
      worktreePath: "/tmp/maister/worktrees/run-1",
      parentRepoPath: "/tmp/repo",
      branch: "maister/run-1",
      baseRef: "abc1234",
      runId: "run-1",
    });
    expect(d.claimLifecycleOperation).toHaveBeenCalledWith({
      runId: "run-1",
      workspaceId: "workspace-1",
      operation: "archive",
    });
    expect(d.recordArchive).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      archivedBranch: "maister/archive/run-1",
      archivedAt: new Date("2026-06-09T08:00:00.000Z"),
    });
    expect(d.finalizeLifecycleOperation).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      attemptId: "lifecycle-attempt-1",
      state: "done",
    });
  });

  it("archive refuses to mutate DB state when preservation fails", async () => {
    const d = deps(context());

    vi.mocked(d.preserveWorktree).mockResolvedValueOnce({ ok: false });

    await expect(archiveWorkbench("run-1", { deps: d })).rejects.toThrow(
      /could not preserve worktree/,
    );

    expect(d.recordArchive).not.toHaveBeenCalled();
    expect(d.finalizeLifecycleOperation).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      attemptId: "lifecycle-attempt-1",
      state: "failed",
    });
  });

  it("drop preserves before removing and records removal after remove succeeds", async () => {
    const order: string[] = [];
    const d = deps(context());

    vi.mocked(d.claimLifecycleOperation).mockImplementationOnce(async () => {
      order.push("claim");

      return { attemptId: "lifecycle-attempt-1" };
    });
    vi.mocked(d.preserveWorktree).mockImplementationOnce(async () => {
      order.push("preserve");

      return {
        ok: true,
        archivedBranch: "maister/archive/run-1",
        archivedAt: new Date("2026-06-09T08:00:00.000Z"),
      };
    });
    vi.mocked(d.removeOwnedWorktree).mockImplementationOnce(async () => {
      order.push("remove");
    });
    vi.mocked(d.recordDrop).mockImplementationOnce(async () => {
      order.push("record");
    });
    vi.mocked(d.finalizeLifecycleOperation).mockImplementationOnce(async () => {
      order.push("finalize");
    });

    const result = await dropWorkbench("run-1", { deps: d });

    expect(result).toMatchObject({
      ok: true,
      runStatus: "Abandoned",
      workspaceRemoved: true,
    });
    expect(order).toEqual([
      "claim",
      "preserve",
      "remove",
      "record",
      "finalize",
    ]);
    expect(d.recordDrop).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        runKind: "flow",
        workspaceId: "workspace-1",
        expectedRunStatus: "Review",
        nextRunStatus: "Abandoned",
      }),
    );
    expect(d.removeOwnedWorktree).toHaveBeenCalledWith({
      projectRepoPath: "/tmp/repo",
      worktreePath: "/tmp/maister/worktrees/run-1",
      allowedRoot: "/tmp/maister/worktrees",
      force: true,
    });
  });

  it("export refuses dirty worktrees unless snapshot is explicit", async () => {
    const d = deps(context());

    vi.mocked(d.statusPorcelain).mockResolvedValueOnce(" M file.ts\n");

    await expect(
      exportWorkbenchBranch("run-1", {
        remote: "origin",
        snapshotDirty: false,
        commitMessage: null,
        deps: d,
      }),
    ).rejects.toThrow(/dirty worktree/);

    expect(d.snapshotDirtyWorktree).not.toHaveBeenCalled();
    expect(d.pushBranch).not.toHaveBeenCalled();
    expect(d.claimLifecycleOperation).not.toHaveBeenCalled();
  });

  it("export validates commit message before claiming dirty work", async () => {
    const d = deps(context());

    vi.mocked(d.statusPorcelain).mockResolvedValueOnce(" M file.ts\n");

    await expect(
      exportWorkbenchBranch("run-1", {
        remote: "origin",
        snapshotDirty: true,
        commitMessage: "   ",
        deps: d,
      }),
    ).rejects.toThrow(/commitMessage is required/);

    expect(d.claimLifecycleOperation).not.toHaveBeenCalled();
    expect(d.snapshotDirtyWorktree).not.toHaveBeenCalled();
    expect(d.pushBranch).not.toHaveBeenCalled();
  });

  it("export refuses missing remotes before status checks and lifecycle claims", async () => {
    const d = deps(context());

    vi.mocked(d.listRemotes).mockResolvedValueOnce(["backup"]);

    await expect(
      exportWorkbenchBranch("run-1", {
        remote: "origin",
        snapshotDirty: false,
        commitMessage: null,
        deps: d,
      }),
    ).rejects.toThrow(/remote does not exist/);

    expect(d.statusPorcelain).not.toHaveBeenCalled();
    expect(d.claimLifecycleOperation).not.toHaveBeenCalled();
    expect(d.pushBranch).not.toHaveBeenCalled();
  });

  it("export snapshots dirty work before pushing when explicitly requested", async () => {
    const d = deps(context());

    vi.mocked(d.statusPorcelain).mockResolvedValueOnce("?? file.ts\n");
    vi.mocked(d.snapshotDirtyWorktree).mockResolvedValueOnce(true);

    const result = await exportWorkbenchBranch("run-1", {
      remote: "origin",
      snapshotDirty: true,
      commitMessage: "maister: hand off run-1",
      deps: d,
    });

    expect(d.snapshotDirtyWorktree).toHaveBeenCalledWith({
      worktreePath: "/tmp/maister/worktrees/run-1",
      commitMessage: "maister: hand off run-1",
    });
    expect(d.pushBranch).toHaveBeenCalledWith({
      projectRepoPath: "/tmp/repo",
      remote: "origin",
      branch: "maister/run-1",
      force: undefined,
    });
    expect(d.claimLifecycleOperation).toHaveBeenCalledWith({
      runId: "run-1",
      workspaceId: "workspace-1",
      operation: "exportBranch",
    });
    expect(d.finalizeLifecycleOperation).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      attemptId: "lifecycle-attempt-1",
      state: "done",
    });
    expect(result).toMatchObject({
      ok: true,
      branch: "maister/run-1",
      remote: "origin",
      pushedRef: "origin/maister/run-1",
      snapshotCreated: true,
      checkoutCommands: [
        "git -C /tmp/repo fetch origin maister/run-1",
        "git -C /tmp/repo switch maister/run-1",
      ],
    });
  });

  it("export forwards force-with-lease intent to git push", async () => {
    const d = deps(context());

    await exportWorkbenchBranch("run-1", {
      remote: "origin",
      snapshotDirty: false,
      commitMessage: null,
      force: true,
      deps: d,
    });

    expect(d.pushBranch).toHaveBeenCalledWith({
      projectRepoPath: "/tmp/repo",
      remote: "origin",
      branch: "maister/run-1",
      force: true,
    });
  });

  it("export leaves transient push failures retryable", async () => {
    const d = deps(context());

    vi.mocked(d.pushBranch).mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "git push failed"),
    );

    await expect(
      exportWorkbenchBranch("run-1", {
        remote: "origin",
        snapshotDirty: false,
        commitMessage: null,
        deps: d,
      }),
    ).rejects.toThrow(/git push failed/);

    expect(d.finalizeLifecycleOperation).not.toHaveBeenCalled();
  });

  it("checks active session before loading run context", async () => {
    const d = deps(context());

    vi.mocked(d.requireActiveSession).mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "Sign in required"),
    );

    await expect(
      archiveWorkbench("missing-run", { deps: d }),
    ).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });

    expect(d.loadContext).not.toHaveBeenCalled();
  });

  it("stop resolves the live supervisor session by ACP id and parks the run in Review", async () => {
    const d = deps(context({ run: { ...context().run, status: "Running" } }));

    vi.mocked(d.listSessions).mockResolvedValueOnce([
      {
        sessionId: "supervisor-1",
        runId: "run-1",
        projectSlug: "demo",
        stepId: "implement",
        status: "live",
        pid: 123,
        startedAt: "2026-06-09T08:00:00.000Z",
        logPath: "/tmp/log",
        monotonicId: 1,
        acpSessionId: "acp-1",
      },
    ]);

    const result = await stopFlowWorkbench("run-1", { deps: d });

    expect(d.deleteSession).toHaveBeenCalledWith("supervisor-1");
    expect(d.markStoppedAndCloseAssignments).toHaveBeenCalledWith({
      runId: "run-1",
      endedAt: expect.any(Date),
      reason: "run stopped by operator",
    });
    expect(result).toMatchObject({
      ok: true,
      runStatus: "Review",
      supervisorStopped: true,
    });
  });

  it("stop still succeeds when queue promotion fails after the run is parked", async () => {
    const d = deps(context({ run: { ...context().run, status: "Running" } }));

    vi.mocked(d.promoteNextPending).mockRejectedValueOnce(
      new MaisterError("CRASH", "scheduler down"),
    );

    const result = await stopFlowWorkbench("run-1", { deps: d });

    expect(d.markStoppedAndCloseAssignments).toHaveBeenCalledWith({
      runId: "run-1",
      endedAt: expect.any(Date),
      reason: "run stopped by operator",
    });
    expect(result).toMatchObject({
      ok: true,
      runStatus: "Review",
    });
  });
});
