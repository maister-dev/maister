import { describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  createWorkbenchHandoffBranch,
  getWorkbenchHandoffMetadata,
  snapshotWorkbenchCommit,
  type LifecycleContext,
  type WorkbenchLifecycleDeps,
} from "@/lib/workbench-lifecycle/service";

type HandoffDeps = WorkbenchLifecycleDeps & {
  claimLifecycleOperation: (args: {
    runId: string;
    workspaceId: string;
    operation: string;
  }) => Promise<{ attemptId: string }>;
  finalizeLifecycleOperation: (args: {
    workspaceId: string;
    attemptId: string;
    state: "done" | "failed";
  }) => Promise<void>;
  listRemotes: (args: { projectRepoPath: string }) => Promise<string[]>;
  headCommit: (args: { worktreePath: string }) => Promise<string>;
  localBranchHead: (args: {
    projectRepoPath: string;
    branch: string;
  }) => Promise<string | null>;
  remoteBranchHead: (args: {
    projectRepoPath: string;
    remote: string;
    branch: string;
  }) => Promise<string | null>;
  createBranchAtHead: (args: {
    worktreePath: string;
    branch: string;
  }) => Promise<void>;
};

function context(over: Partial<LifecycleContext> = {}): LifecycleContext {
  return {
    project: {
      id: "project-1",
      mainBranch: "main",
    },
    run: {
      id: "run-1",
      projectId: "project-1",
      taskId: null,
      runKind: "flow",
      status: "Review",
      currentStepId: null,
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

function deps(ctx: LifecycleContext = context()): HandoffDeps {
  return {
    requireActiveSession: vi.fn(async () => undefined),
    loadContext: vi.fn(async () => ctx),
    authorize: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    deleteSession: vi.fn(async () => undefined),
    listRunSessionAcpIds: vi.fn(async () => []),
    markStoppedAndCloseAssignments: vi.fn(async () => undefined),
    promoteNextPending: vi.fn(async () => undefined),
    preserveWorktree: vi.fn(async () => ({
      ok: true,
      archivedBranch: "maister/archive/run-1",
      archivedAt: new Date("2026-06-09T08:00:00.000Z"),
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
    listRemotes: vi.fn(async () => ["origin", "backup"]),
    headCommit: vi.fn(async () => "abc1234"),
    localBranchHead: vi.fn(async () => null),
    remoteBranchHead: vi.fn(async () => null),
    createBranchAtHead: vi.fn(async () => undefined),
    cascadeOrchestratorIfNeeded: vi.fn(async () => undefined),
  };
}

describe("workbench lifecycle handoff services", () => {
  it("returns handoff metadata from server-derived workspace state without mutation", async () => {
    const d = deps();

    vi.mocked(d.statusPorcelain).mockResolvedValueOnce(" M src/app.ts\n");

    const result = await getWorkbenchHandoffMetadata("run-1", { deps: d });

    expect(result).toEqual({
      ok: true,
      runId: "run-1",
      branch: "maister/run-1",
      dirty: true,
      remotes: ["origin", "backup"],
      defaultRemote: "origin",
      suggestedHandoffBranch: "maister/handoff/run-1",
      checkoutCommands: [
        "git -C /tmp/repo fetch origin maister/handoff/run-1",
        "git -C /tmp/repo switch --track origin/maister/handoff/run-1",
      ],
    });
    expect(d.authorize).toHaveBeenCalledWith("project-1", "promoteRun");
    expect(d.listRemotes).toHaveBeenCalledWith({
      projectRepoPath: "/tmp/repo",
    });
    expect(d.claimLifecycleOperation).not.toHaveBeenCalled();
    expect(d.createBranchAtHead).not.toHaveBeenCalled();
  });

  it("snapshot commit refuses a clean worktree before claiming", async () => {
    const d = deps();

    await expect(
      snapshotWorkbenchCommit("run-1", {
        commitMessage: "maister: snapshot run-1",
        deps: d,
      }),
    ).rejects.toThrow(/worktree is clean/);

    expect(d.claimLifecycleOperation).not.toHaveBeenCalled();
    expect(d.snapshotDirtyWorktree).not.toHaveBeenCalled();
  });

  it("snapshot commit claims the operation, commits dirty work, and returns the new head", async () => {
    const d = deps();

    vi.mocked(d.statusPorcelain).mockResolvedValueOnce("?? src/new.ts\n");
    vi.mocked(d.snapshotDirtyWorktree).mockResolvedValueOnce(true);
    vi.mocked(d.headCommit).mockResolvedValueOnce("def5678");

    const result = await snapshotWorkbenchCommit("run-1", {
      commitMessage: "maister: snapshot run-1",
      deps: d,
    });

    expect(d.claimLifecycleOperation).toHaveBeenCalledWith({
      runId: "run-1",
      workspaceId: "workspace-1",
      operation: "snapshotCommit",
    });
    expect(d.snapshotDirtyWorktree).toHaveBeenCalledWith({
      worktreePath: "/tmp/maister/worktrees/run-1",
      commitMessage: "maister: snapshot run-1",
    });
    expect(d.finalizeLifecycleOperation).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      attemptId: "lifecycle-attempt-1",
      state: "done",
    });
    expect(result).toEqual({
      ok: true,
      runId: "run-1",
      branch: "maister/run-1",
      commit: "def5678",
      snapshotCreated: true,
    });
  });

  it("does not snapshot when the lifecycle claim is lost", async () => {
    const d = deps();

    vi.mocked(d.statusPorcelain).mockResolvedValueOnce(" M file.ts\n");
    vi.mocked(d.claimLifecycleOperation).mockRejectedValueOnce(
      new MaisterError("CONFLICT", "lifecycle operation already in progress"),
    );

    await expect(
      snapshotWorkbenchCommit("run-1", {
        commitMessage: "maister: snapshot run-1",
        deps: d,
      }),
    ).rejects.toThrow(/already in progress/);

    expect(d.snapshotDirtyWorktree).not.toHaveBeenCalled();
    expect(d.finalizeLifecycleOperation).not.toHaveBeenCalled();
  });

  it("handoff branch refuses dirty worktrees before claiming", async () => {
    const d = deps();

    vi.mocked(d.statusPorcelain).mockResolvedValueOnce(" M file.ts\n");

    await expect(
      createWorkbenchHandoffBranch("run-1", {
        remote: "origin",
        handoffBranch: "maister/handoff/run-1",
        deps: d,
      }),
    ).rejects.toThrow(/commit dirty work before handoff/);

    expect(d.claimLifecycleOperation).not.toHaveBeenCalled();
    expect(d.createBranchAtHead).not.toHaveBeenCalled();
    expect(d.pushBranch).not.toHaveBeenCalled();
  });

  it("handoff branch refuses local and remote collisions without creating refs", async () => {
    const localCollision = deps();

    vi.mocked(localCollision.localBranchHead).mockResolvedValueOnce("def5678");

    await expect(
      createWorkbenchHandoffBranch("run-1", {
        remote: "origin",
        handoffBranch: "maister/handoff/run-1",
        deps: localCollision,
      }),
    ).rejects.toThrow(/local branch already exists at a different commit/);
    expect(localCollision.createBranchAtHead).not.toHaveBeenCalled();

    const remoteCollision = deps();

    vi.mocked(remoteCollision.remoteBranchHead).mockResolvedValueOnce(
      "def5678",
    );

    await expect(
      createWorkbenchHandoffBranch("run-1", {
        remote: "origin",
        handoffBranch: "maister/handoff/run-1",
        deps: remoteCollision,
      }),
    ).rejects.toThrow(/remote branch already exists at a different commit/);
    expect(remoteCollision.createBranchAtHead).not.toHaveBeenCalled();
  });

  it("handoff branch validates branch and remote before creating refs", async () => {
    const invalidBranch = deps();

    await expect(
      createWorkbenchHandoffBranch("run-1", {
        remote: "origin",
        handoffBranch: "../bad",
        deps: invalidBranch,
      }),
    ).rejects.toThrow(/Invalid branch/);
    expect(invalidBranch.claimLifecycleOperation).not.toHaveBeenCalled();
    expect(invalidBranch.createBranchAtHead).not.toHaveBeenCalled();

    const missingRemote = deps();

    vi.mocked(missingRemote.listRemotes).mockResolvedValueOnce(["backup"]);

    await expect(
      createWorkbenchHandoffBranch("run-1", {
        remote: "origin",
        handoffBranch: "maister/handoff/run-1",
        deps: missingRemote,
      }),
    ).rejects.toThrow(/remote does not exist/);
    expect(missingRemote.claimLifecycleOperation).not.toHaveBeenCalled();
    expect(missingRemote.createBranchAtHead).not.toHaveBeenCalled();
  });

  it("handoff branch leaves transient push failure retryable", async () => {
    const d = deps();

    vi.mocked(d.pushBranch).mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "git push failed"),
    );

    await expect(
      createWorkbenchHandoffBranch("run-1", {
        remote: "origin",
        handoffBranch: "maister/handoff/run-1",
        deps: d,
      }),
    ).rejects.toThrow(/git push failed/);

    expect(d.finalizeLifecycleOperation).not.toHaveBeenCalled();
  });

  it("handoff branch retry reuses a same-head local branch after transient push failure", async () => {
    const d = deps();

    vi.mocked(d.localBranchHead)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("abc1234");
    vi.mocked(d.pushBranch)
      .mockRejectedValueOnce(
        new MaisterError("EXECUTOR_UNAVAILABLE", "git push failed"),
      )
      .mockResolvedValueOnce(undefined);

    await expect(
      createWorkbenchHandoffBranch("run-1", {
        remote: "origin",
        handoffBranch: "maister/handoff/run-1",
        deps: d,
      }),
    ).rejects.toThrow(/git push failed/);

    const retry = await createWorkbenchHandoffBranch("run-1", {
      remote: "origin",
      handoffBranch: "maister/handoff/run-1",
      deps: d,
    });

    expect(d.createBranchAtHead).toHaveBeenCalledTimes(1);
    expect(d.pushBranch).toHaveBeenCalledTimes(2);
    expect(retry).toMatchObject({
      ok: true,
      handoffBranch: "maister/handoff/run-1",
      headCommit: "abc1234",
    });
  });

  it("handoff branch retry completes when the remote branch already matches head", async () => {
    const d = deps();

    vi.mocked(d.remoteBranchHead).mockResolvedValueOnce("abc1234");

    const result = await createWorkbenchHandoffBranch("run-1", {
      remote: "origin",
      handoffBranch: "maister/handoff/run-1",
      deps: d,
    });

    expect(d.createBranchAtHead).toHaveBeenCalledWith({
      worktreePath: "/tmp/maister/worktrees/run-1",
      branch: "maister/handoff/run-1",
    });
    expect(d.pushBranch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      pushedRef: "origin/maister/handoff/run-1",
      headCommit: "abc1234",
    });
  });

  it("handoff branch creates and pushes a clean collision-free branch", async () => {
    const d = deps();

    const result = await createWorkbenchHandoffBranch("run-1", {
      remote: "origin",
      handoffBranch: "maister/handoff/run-1",
      deps: d,
    });

    expect(d.claimLifecycleOperation).toHaveBeenCalledWith({
      runId: "run-1",
      workspaceId: "workspace-1",
      operation: "handoffBranch",
    });
    expect(d.createBranchAtHead).toHaveBeenCalledWith({
      worktreePath: "/tmp/maister/worktrees/run-1",
      branch: "maister/handoff/run-1",
    });
    expect(d.pushBranch).toHaveBeenCalledWith({
      projectRepoPath: "/tmp/repo",
      remote: "origin",
      branch: "maister/handoff/run-1",
      force: undefined,
    });
    expect(result).toEqual({
      ok: true,
      runId: "run-1",
      branch: "maister/run-1",
      handoffBranch: "maister/handoff/run-1",
      remote: "origin",
      pushedRef: "origin/maister/handoff/run-1",
      headCommit: "abc1234",
      checkoutCommands: [
        "git -C /tmp/repo fetch origin maister/handoff/run-1",
        "git -C /tmp/repo switch --track origin/maister/handoff/run-1",
      ],
    });
  });
});
