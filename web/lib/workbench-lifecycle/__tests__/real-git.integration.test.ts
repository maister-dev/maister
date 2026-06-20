import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { preserveWorktree } from "@/lib/gc/preserve";
import {
  createBranchAtHead,
  headCommit,
  listRemotes,
  localBranchHead,
  pushBranch,
  remoteBranchHead,
  removeOwnedWorktree,
  snapshotDirtyWorktree,
  statusPorcelain,
} from "@/lib/worktree";
import {
  archiveWorkbench,
  createWorkbenchHandoffBranch,
  dropWorkbench,
  exportWorkbenchBranch,
  snapshotWorkbenchCommit,
  type LifecycleContext,
  type RecordArchiveInput,
  type RecordDropInput,
  type WorkbenchLifecycleDeps,
} from "@/lib/workbench-lifecycle/service";

const execFileAsync = promisify(execFile);

type GitWorkbench = {
  repo: string;
  worktree: string;
  worktreesRoot: string;
  bareRemote: string;
  baseSha: string;
  runId: string;
  branch: string;
};

type LifecycleRecords = {
  archives: RecordArchiveInput[];
  drops: RecordDropInput[];
};

const createdPaths: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });

  return stdout;
}

async function track(path: string): Promise<string> {
  createdPaths.push(path);

  return path;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
}

async function createGitWorkbench(runId = "run-real"): Promise<GitWorkbench> {
  const repo = await track(await mkdtemp(join(tmpdir(), "maister-parent-")));
  const worktreesRoot = await track(
    await mkdtemp(join(tmpdir(), "maister-worktrees-")),
  );
  const bareRemote = await track(
    await mkdtemp(join(tmpdir(), "maister-remote-")),
  );
  const worktree = join(worktreesRoot, runId);
  const branch = `maister/${runId}`;

  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@maister.local");
  await git(repo, "config", "user.name", "MAIster Test");
  await git(repo, "config", "commit.gpgsign", "false");
  await git(bareRemote, "init", "-q", "--bare", "-b", "main");
  await git(repo, "remote", "add", "origin", bareRemote);

  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");
  const baseSha = (await git(repo, "rev-parse", "HEAD")).trim();

  await git(repo, "worktree", "add", "-q", "-b", branch, worktree, "HEAD");

  return { repo, worktree, worktreesRoot, bareRemote, baseSha, runId, branch };
}

function lifecycleContext(workbench: GitWorkbench): LifecycleContext {
  return {
    project: {
      id: "project-real",
      mainBranch: "main",
    },
    run: {
      id: workbench.runId,
      projectId: "project-real",
      taskId: null,
      runKind: "flow",
      status: "Review",
      acpSessionId: null,
      currentStepId: null,
    },
    workspace: {
      id: `workspace-${workbench.runId}`,
      runId: workbench.runId,
      projectId: "project-real",
      branch: workbench.branch,
      worktreePath: workbench.worktree,
      parentRepoPath: workbench.repo,
      removedAt: null,
      archivedBranch: null,
      archivedAt: null,
      baseBranch: "main",
      baseCommit: workbench.baseSha,
    },
  };
}

function realGitDeps(
  ctx: LifecycleContext,
  worktreesRootPath: string,
  records: LifecycleRecords,
): WorkbenchLifecycleDeps {
  return {
    requireActiveSession: vi.fn(async () => undefined),
    loadContext: vi.fn(async () => ctx),
    authorize: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    deleteSession: vi.fn(async () => undefined),
    markStoppedAndCloseAssignments: vi.fn(async () => undefined),
    promoteNextPending: vi.fn(async () => undefined),
    preserveWorktree,
    recordArchive: vi.fn(async (args) => {
      records.archives.push(args);
    }),
    recordDrop: vi.fn(async (args) => {
      records.drops.push(args);
    }),
    removeOwnedWorktree,
    worktreesRoot: vi.fn(() => worktreesRootPath),
    statusPorcelain,
    snapshotDirtyWorktree,
    pushBranch,
    claimLifecycleOperation: vi.fn(async () => ({ attemptId: "attempt-real" })),
    finalizeLifecycleOperation: vi.fn(async () => undefined),
    listRemotes,
    headCommit,
    localBranchHead,
    remoteBranchHead,
    createBranchAtHead,
    cascadeOrchestratorIfNeeded: vi.fn(async () => undefined),
  };
}

function records(): LifecycleRecords {
  return { archives: [], drops: [] };
}

beforeEach(() => {
  createdPaths.length = 0;
});

afterEach(async () => {
  await Promise.all(
    createdPaths.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("workbench lifecycle real git integration", () => {
  it("snapshot commit then handoff branch creates and pushes a clean continuation ref", async () => {
    const workbench = await createGitWorkbench();
    const store = records();
    const deps = realGitDeps(
      lifecycleContext(workbench),
      workbench.worktreesRoot,
      store,
    );

    await writeFile(join(workbench.worktree, "scratch.txt"), "dirty work\n");

    const snapshot = await snapshotWorkbenchCommit(workbench.runId, {
      commitMessage: "maister: snapshot dirty work",
      deps,
    });

    expect(snapshot.snapshotCreated).toBe(true);
    expect(snapshot.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(
      (await git(workbench.worktree, "status", "--porcelain=v1")).trim(),
    ).toBe("");

    const handoff = await createWorkbenchHandoffBranch(workbench.runId, {
      remote: "origin",
      handoffBranch: `maister/handoff/${workbench.runId}`,
      deps,
    });

    expect(handoff).toMatchObject({
      ok: true,
      handoffBranch: `maister/handoff/${workbench.runId}`,
      remote: "origin",
      pushedRef: `origin/maister/handoff/${workbench.runId}`,
      headCommit: snapshot.commit,
    });

    const remoteRef = await git(
      workbench.bareRemote,
      "show-ref",
      "--verify",
      `refs/heads/maister/handoff/${workbench.runId}`,
    );

    expect(remoteRef).toContain(snapshot.commit);
    expect((await git(workbench.repo, "branch", "--show-current")).trim()).toBe(
      "main",
    );
  });

  it("export pushes the existing run branch to the selected remote", async () => {
    const workbench = await createGitWorkbench("run-export");
    const store = records();
    const deps = realGitDeps(
      lifecycleContext(workbench),
      workbench.worktreesRoot,
      store,
    );

    await writeFile(join(workbench.worktree, "export.txt"), "ship this\n");

    const snapshot = await snapshotWorkbenchCommit(workbench.runId, {
      commitMessage: "maister: snapshot export",
      deps,
    });
    const result = await exportWorkbenchBranch(workbench.runId, {
      remote: "origin",
      snapshotDirty: false,
      commitMessage: null,
      deps,
    });

    expect(result).toMatchObject({
      ok: true,
      branch: workbench.branch,
      remote: "origin",
      pushedRef: `origin/${workbench.branch}`,
      snapshotCreated: false,
    });

    const remoteRef = await git(
      workbench.bareRemote,
      "show-ref",
      "--verify",
      `refs/heads/${workbench.branch}`,
    );

    expect(remoteRef).toContain(snapshot.commit);
  });

  it("export reports non-fast-forward conflicts and force-with-lease can retry", async () => {
    const workbench = await createGitWorkbench("run-export-force");
    const store = records();
    const deps = realGitDeps(
      lifecycleContext(workbench),
      workbench.worktreesRoot,
      store,
    );

    await writeFile(join(workbench.worktree, "export-force.txt"), "local\n");

    const snapshot = await snapshotWorkbenchCommit(workbench.runId, {
      commitMessage: "maister: snapshot export",
      deps,
    });

    await exportWorkbenchBranch(workbench.runId, {
      remote: "origin",
      snapshotDirty: false,
      commitMessage: null,
      deps,
    });

    await writeFile(join(workbench.repo, "remote-move.txt"), "remote\n");
    await git(workbench.repo, "add", "-A");
    await git(workbench.repo, "commit", "-q", "-m", "remote move");
    const remoteSha = (await git(workbench.repo, "rev-parse", "HEAD")).trim();

    await git(
      workbench.repo,
      "push",
      "origin",
      "--force",
      `${remoteSha}:refs/heads/${workbench.branch}`,
    );

    await expect(
      exportWorkbenchBranch(workbench.runId, {
        remote: "origin",
        snapshotDirty: false,
        commitMessage: null,
        deps,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      pushRejected: "non_fast_forward",
      canForce: true,
    });

    await git(
      workbench.repo,
      "fetch",
      "origin",
      `${workbench.branch}:refs/remotes/origin/${workbench.branch}`,
    );

    await exportWorkbenchBranch(workbench.runId, {
      remote: "origin",
      snapshotDirty: false,
      commitMessage: null,
      force: true,
      deps,
    });

    const remoteRef = await git(
      workbench.bareRemote,
      "show-ref",
      "--verify",
      `refs/heads/${workbench.branch}`,
    );

    expect(remoteRef).toContain(snapshot.commit);
  });

  it("archive preserves dirty work in an archive ref before DB archive state", async () => {
    const workbench = await createGitWorkbench("run-archive");
    const store = records();
    const deps = realGitDeps(
      lifecycleContext(workbench),
      workbench.worktreesRoot,
      store,
    );

    await writeFile(join(workbench.worktree, "archive-note.txt"), "keep me\n");

    const result = await archiveWorkbench(workbench.runId, { deps });

    expect(result).toMatchObject({
      ok: true,
      archived: true,
      archivedBranch: `maister/archive/${workbench.runId}`,
      snapshotted: true,
    });
    expect(store.archives).toHaveLength(1);
    expect(store.archives[0]?.archivedBranch).toBe(
      `maister/archive/${workbench.runId}`,
    );

    const archived = await git(
      workbench.worktree,
      "show",
      `maister/archive/${workbench.runId}:archive-note.txt`,
    );

    expect(archived).toContain("keep me");
  });

  it("drop preserves dirty work before removing only a MAIster-owned worktree", async () => {
    const workbench = await createGitWorkbench("run-drop");
    const store = records();
    const deps = realGitDeps(
      lifecycleContext(workbench),
      workbench.worktreesRoot,
      store,
    );

    await writeFile(join(workbench.worktree, "drop-note.txt"), "preserve\n");

    const result = await dropWorkbench(workbench.runId, { deps });

    expect(result).toMatchObject({
      ok: true,
      runStatus: "Abandoned",
      workspaceRemoved: true,
      archivedBranch: `maister/archive/${workbench.runId}`,
    });
    expect(store.drops).toHaveLength(1);
    expect(await pathExists(workbench.worktree)).toBe(false);

    const archived = await git(
      workbench.repo,
      "show",
      `maister/archive/${workbench.runId}:drop-note.txt`,
    );

    expect(archived).toContain("preserve");
  });

  it("drop refuses to remove a worktree outside the allowed worktrees root", async () => {
    const workbench = await createGitWorkbench("run-unsafe");
    const disallowedRoot = await track(
      await mkdtemp(join(tmpdir(), "maister-other-root-")),
    );
    const store = records();
    const deps = realGitDeps(
      lifecycleContext(workbench),
      disallowedRoot,
      store,
    );

    await writeFile(join(workbench.worktree, "unsafe.txt"), "still here\n");

    await expect(dropWorkbench(workbench.runId, { deps })).rejects.toThrow(
      /outside allowed root/,
    );

    expect(store.drops).toEqual([]);
    expect(await pathExists(workbench.worktree)).toBe(true);
  });
});
