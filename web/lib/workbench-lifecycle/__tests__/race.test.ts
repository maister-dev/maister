import { describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  archiveWorkbench,
  createWorkbenchHandoffBranch,
  dropWorkbench,
  exportWorkbenchBranch,
  snapshotWorkbenchCommit,
  type LifecycleContext,
  type LifecycleOperationName,
  type WorkbenchLifecycleDeps,
} from "@/lib/workbench-lifecycle/service";

function context(): LifecycleContext {
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
      acpSessionId: null,
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
  };
}

function claimOnce(): WorkbenchLifecycleDeps["claimLifecycleOperation"] {
  let claimed = false;

  return vi.fn(
    async (_args: {
      runId: string;
      workspaceId: string;
      operation: LifecycleOperationName;
    }) => {
      if (claimed) {
        throw new MaisterError(
          "CONFLICT",
          "lifecycle operation already in progress",
        );
      }

      claimed = true;

      return { attemptId: "attempt-1" };
    },
  );
}

function deps(
  over: Partial<WorkbenchLifecycleDeps> = {},
): WorkbenchLifecycleDeps {
  return {
    requireActiveSession: vi.fn(async () => undefined),
    loadContext: vi.fn(async () => context()),
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
    snapshotDirtyWorktree: vi.fn(async () => true),
    pushBranch: vi.fn(async () => undefined),
    claimLifecycleOperation: claimOnce(),
    finalizeLifecycleOperation: vi.fn(async () => undefined),
    listRemotes: vi.fn(async () => ["origin"]),
    headCommit: vi.fn(async () => "abc1234"),
    localBranchHead: vi.fn(async () => null),
    remoteBranchHead: vi.fn(async () => null),
    createBranchAtHead: vi.fn(async () => undefined),
    cascadeOrchestratorIfNeeded: vi.fn(async () => undefined),
    ...over,
  };
}

async function expectOneOwner(
  calls: readonly [Promise<unknown>, Promise<unknown>],
): Promise<void> {
  const results = await Promise.allSettled(calls);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.reason).toBeInstanceOf(MaisterError);
  expect((rejected[0]?.reason as MaisterError).code).toBe("CONFLICT");
}

describe("workbench lifecycle race/idempotency", () => {
  it("allows only one archive owner to preserve and record archive state", async () => {
    const d = deps();

    await expectOneOwner([
      archiveWorkbench("run-1", { deps: d }),
      archiveWorkbench("run-1", { deps: d }),
    ]);

    expect(d.preserveWorktree).toHaveBeenCalledTimes(1);
    expect(d.recordArchive).toHaveBeenCalledTimes(1);
    expect(d.finalizeLifecycleOperation).toHaveBeenCalledTimes(1);
  });

  it("allows only one drop owner to preserve, remove, and record removal", async () => {
    const d = deps();

    await expectOneOwner([
      dropWorkbench("run-1", { deps: d }),
      dropWorkbench("run-1", { deps: d }),
    ]);

    expect(d.preserveWorktree).toHaveBeenCalledTimes(1);
    expect(d.removeOwnedWorktree).toHaveBeenCalledTimes(1);
    expect(d.recordDrop).toHaveBeenCalledTimes(1);
  });

  it("allows only one export owner to push the run branch", async () => {
    const d = deps();

    await expectOneOwner([
      exportWorkbenchBranch("run-1", {
        remote: "origin",
        snapshotDirty: false,
        commitMessage: null,
        deps: d,
      }),
      exportWorkbenchBranch("run-1", {
        remote: "origin",
        snapshotDirty: false,
        commitMessage: null,
        deps: d,
      }),
    ]);

    expect(d.pushBranch).toHaveBeenCalledTimes(1);
    expect(d.snapshotDirtyWorktree).not.toHaveBeenCalled();
  });

  it("allows only one snapshot owner to commit dirty work", async () => {
    const d = deps({
      statusPorcelain: vi.fn(async () => " M file.ts\n"),
      headCommit: vi.fn(async () => "def5678"),
    });

    await expectOneOwner([
      snapshotWorkbenchCommit("run-1", {
        commitMessage: "maister: snapshot run-1",
        deps: d,
      }),
      snapshotWorkbenchCommit("run-1", {
        commitMessage: "maister: snapshot run-1",
        deps: d,
      }),
    ]);

    expect(d.snapshotDirtyWorktree).toHaveBeenCalledTimes(1);
    expect(d.headCommit).toHaveBeenCalledTimes(1);
  });

  it("allows only one handoff owner to create and push the handoff branch", async () => {
    const d = deps();

    await expectOneOwner([
      createWorkbenchHandoffBranch("run-1", {
        remote: "origin",
        handoffBranch: "maister/handoff/run-1",
        deps: d,
      }),
      createWorkbenchHandoffBranch("run-1", {
        remote: "origin",
        handoffBranch: "maister/handoff/run-1",
        deps: d,
      }),
    ]);

    expect(d.createBranchAtHead).toHaveBeenCalledTimes(1);
    expect(d.pushBranch).toHaveBeenCalledTimes(1);
  });
});
