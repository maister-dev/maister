import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  abortSyncOperation,
  addWorktree,
  addWorktreeForBranch,
  aheadBehindCounts,
  branchHasUpstream,
  ffUpdateLocalBranch,
  hasConflictMarkers,
  mergeFromRef,
  rebaseOntoRef,
  syncOperationInProgress,
} from "@/lib/worktree";

const execFileAsync = promisify(execFile);

let root: string;
let repo: string;

beforeEach(async () => {
  root = join(tmpdir(), `worktree-sync-test-${randomUUID()}`);
  repo = join(root, "repo");

  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@example.test"]);
  await git(repo, ["config", "user.name", "Test User"]);
  await writeFile(join(repo, "file.txt"), "base\n");
  await git(repo, ["add", "file.txt"]);
  await git(repo, ["commit", "-m", "initial"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function git(
  cwd: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd });
}

async function headSha(cwd: string, rev = "HEAD"): Promise<string> {
  return (await git(cwd, ["rev-parse", rev])).stdout.trim();
}

// An add/add conflict on TWO files: the worktree branch and main each add
// fileA.txt + fileB.txt with different content, so rebasing the branch onto main
// conflicts on both files at once.
async function seedTwoFileConflict(): Promise<{ wt: string; before: string }> {
  const wt = join(root, "conflict-wt");

  await addWorktree({
    projectRepoPath: repo,
    branch: "sync/conflict",
    worktreePath: wt,
    startPoint: "main",
  });
  await writeFile(join(wt, "fileA.txt"), "worktree-A\n");
  await writeFile(join(wt, "fileB.txt"), "worktree-B\n");
  await git(wt, ["add", "fileA.txt", "fileB.txt"]);
  await git(wt, ["commit", "-m", "worktree adds A and B"]);
  const before = await headSha(wt);

  await writeFile(join(repo, "fileA.txt"), "main-A\n");
  await writeFile(join(repo, "fileB.txt"), "main-B\n");
  await git(repo, ["add", "fileA.txt", "fileB.txt"]);
  await git(repo, ["commit", "-m", "main adds A and B"]);

  return { wt, before };
}

describe("branch-sync worktree helpers", () => {
  it("aheadBehindCounts reports exact ahead/behind on a diverged history", async () => {
    await git(repo, ["checkout", "-b", "feature"]);
    await writeFile(join(repo, "f1.txt"), "f1\n");
    await git(repo, ["add", "f1.txt"]);
    await git(repo, ["commit", "-m", "f1"]);
    await writeFile(join(repo, "f2.txt"), "f2\n");
    await git(repo, ["add", "f2.txt"]);
    await git(repo, ["commit", "-m", "f2"]);
    await git(repo, ["checkout", "main"]);

    for (const name of ["m1", "m2", "m3"]) {
      await writeFile(join(repo, `${name}.txt`), `${name}\n`);
      await git(repo, ["add", `${name}.txt`]);
      await git(repo, ["commit", "-m", name]);
    }

    // base=main, ref=feature: feature is 2 commits ahead of main and 3 behind.
    await expect(aheadBehindCounts(repo, "main", "feature")).resolves.toEqual({
      ahead: 2,
      behind: 3,
    });
  });

  it("rebaseOntoRef reports every conflicted file and leaves the rebase in place", async () => {
    const { wt } = await seedTwoFileConflict();

    const result = await rebaseOntoRef(wt, "main");

    if (result.ok) throw new Error("expected a rebase conflict");
    expect(result.conflict).toBe(true);
    expect(result.conflictedFiles.slice().sort()).toEqual([
      "fileA.txt",
      "fileB.txt",
    ]);
    expect(await syncOperationInProgress(wt)).toBe(true);
  });

  it("rebaseOntoRef cleanly replays the branch onto an advanced ref", async () => {
    const wt = join(root, "clean-rebase-wt");

    await addWorktree({
      projectRepoPath: repo,
      branch: "sync/clean",
      worktreePath: wt,
      startPoint: "main",
    });
    await writeFile(join(wt, "feature.txt"), "feature\n");
    await git(wt, ["add", "feature.txt"]);
    await git(wt, ["commit", "-m", "feature commit"]);
    await writeFile(join(repo, "other.txt"), "other\n");
    await git(repo, ["add", "other.txt"]);
    await git(repo, ["commit", "-m", "main advances"]);

    await expect(rebaseOntoRef(wt, "main")).resolves.toEqual({ ok: true });
    expect(await syncOperationInProgress(wt)).toBe(false);

    // main is now an ancestor of the rebased branch head.
    await expect(
      git(wt, [
        "merge-base",
        "--is-ancestor",
        await headSha(repo, "main"),
        "HEAD",
      ]),
    ).resolves.toBeDefined();
  });

  it("abortSyncOperation restores the pre-rebase HEAD and clears in-progress state", async () => {
    const { wt, before } = await seedTwoFileConflict();

    const result = await rebaseOntoRef(wt, "main");

    expect(result.ok).toBe(false);
    expect(await syncOperationInProgress(wt)).toBe(true);

    await abortSyncOperation(wt);

    expect(await syncOperationInProgress(wt)).toBe(false);
    expect(await headSha(wt)).toBe(before);
    // no-op when nothing is in progress.
    await expect(abortSyncOperation(wt)).resolves.toBeUndefined();
  });

  it("ffUpdateLocalBranch fast-forwards the checked-out branch on a clean tree", async () => {
    await git(repo, ["branch", "ahead", "main"]);
    await git(repo, ["checkout", "ahead"]);
    await writeFile(join(repo, "ff.txt"), "ff\n");
    await git(repo, ["add", "ff.txt"]);
    await git(repo, ["commit", "-m", "ahead commit"]);
    const target = await headSha(repo);

    await git(repo, ["checkout", "main"]);

    await ffUpdateLocalBranch(repo, "main", target);

    expect(await headSha(repo)).toBe(target);
    expect(await headSha(repo, "main")).toBe(target);
  });

  it("ffUpdateLocalBranch refuses a non-fast-forward on the checked-out branch", async () => {
    const base = await headSha(repo);

    await writeFile(join(repo, "a.txt"), "a\n");
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["commit", "-m", "main advances"]);
    await git(repo, ["checkout", "-b", "side", base]);
    await writeFile(join(repo, "b.txt"), "b\n");
    await git(repo, ["add", "b.txt"]);
    await git(repo, ["commit", "-m", "side commit"]);
    const divergent = await headSha(repo);

    await git(repo, ["checkout", "main"]);

    await expect(
      ffUpdateLocalBranch(repo, "main", divergent),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  // H4: a DIRTY parent checkout also makes `merge --ff-only` exit non-zero. The
  // refusal must not be reported as divergence — that named two SHAs in a perfect
  // fast-forward relationship as "diverged" and settled the sync `aborted`. The
  // run's own worktree can be spotless while the parent checkout is dirty, so the
  // upstream dirty check never sees this.
  it("ffUpdateLocalBranch does not report divergence when the parent checkout is merely dirty", async () => {
    await git(repo, ["branch", "ahead", "main"]);
    await git(repo, ["checkout", "ahead"]);
    await writeFile(join(repo, "ff.txt"), "ff\n");
    await git(repo, ["add", "ff.txt"]);
    await git(repo, ["commit", "-m", "ahead commit"]);
    const target = await headSha(repo);

    await git(repo, ["checkout", "main"]);
    // Uncommitted work on the very file the fast-forward would bring in.
    await writeFile(join(repo, "ff.txt"), "dirty local edit\n");

    const err = await ffUpdateLocalBranch(repo, "main", target).catch(
      (e: unknown) => e as { code?: string; message?: string },
    );

    // main IS an ancestor of target, so a divergence claim would be provably false.
    expect(err?.code).toBe("PRECONDITION");
    expect(err?.message).not.toContain("is not an ancestor of");
    expect(err?.message).toContain("uncommitted changes");
  });

  it("ffUpdateLocalBranch fast-forwards a branch that is not checked out", async () => {
    const base = await headSha(repo);

    await git(repo, ["branch", "parked", base]);
    await writeFile(join(repo, "a.txt"), "a\n");
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["commit", "-m", "main advances"]);
    const target = await headSha(repo);

    await ffUpdateLocalBranch(repo, "parked", target);

    expect(await headSha(repo, "parked")).toBe(target);
    // HEAD is untouched by the non-checked-out ref move.
    expect(
      (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(),
    ).toBe("main");
  });

  it("ffUpdateLocalBranch refuses a non-fast-forward on a non-checked-out branch", async () => {
    await git(repo, ["checkout", "-b", "parked"]);
    await writeFile(join(repo, "p.txt"), "p\n");
    await git(repo, ["add", "p.txt"]);
    await git(repo, ["commit", "-m", "parked commit"]);
    const parkedHead = await headSha(repo);

    await git(repo, ["checkout", "main"]);
    await writeFile(join(repo, "m.txt"), "m\n");
    await git(repo, ["add", "m.txt"]);
    await git(repo, ["commit", "-m", "main commit"]);
    const mainHead = await headSha(repo);

    await expect(
      ffUpdateLocalBranch(repo, "parked", mainHead),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    expect(await headSha(repo, "parked")).toBe(parkedHead);
  });

  it("hasConflictMarkers is true during a conflicted rebase and false on a clean tree", async () => {
    const clean = join(root, "clean-markers-wt");

    await addWorktree({
      projectRepoPath: repo,
      branch: "sync/clean-markers",
      worktreePath: clean,
      startPoint: "main",
    });

    expect(await hasConflictMarkers(clean)).toBe(false);

    const { wt } = await seedTwoFileConflict();
    const result = await rebaseOntoRef(wt, "main");

    expect(result.ok).toBe(false);
    expect(await hasConflictMarkers(wt)).toBe(true);
  });

  it("mergeFromRef reports conflicts, tracked by syncOperationInProgress until aborted", async () => {
    const wt = join(root, "merge-conflict-wt");

    await addWorktree({
      projectRepoPath: repo,
      branch: "sync/merge-conflict",
      worktreePath: wt,
      startPoint: "main",
    });
    await writeFile(join(wt, "file.txt"), "worktree side\n");
    await git(wt, ["commit", "-am", "worktree edits file"]);
    await writeFile(join(repo, "file.txt"), "main side\n");
    await git(repo, ["commit", "-am", "main edits file"]);

    const result = await mergeFromRef(wt, "main");

    if (result.ok) throw new Error("expected a merge conflict");
    expect(result.conflictedFiles).toEqual(["file.txt"]);
    expect(await syncOperationInProgress(wt)).toBe(true);

    await abortSyncOperation(wt);

    expect(await syncOperationInProgress(wt)).toBe(false);
  });

  it("mergeFromRef merges a non-overlapping ref cleanly", async () => {
    const wt = join(root, "merge-clean-wt");

    await addWorktree({
      projectRepoPath: repo,
      branch: "sync/merge-clean",
      worktreePath: wt,
      startPoint: "main",
    });
    await writeFile(join(wt, "wt-only.txt"), "wt\n");
    await git(wt, ["add", "wt-only.txt"]);
    await git(wt, ["commit", "-m", "wt only"]);
    await writeFile(join(repo, "main-only.txt"), "main\n");
    await git(repo, ["add", "main-only.txt"]);
    await git(repo, ["commit", "-m", "main only"]);

    await expect(mergeFromRef(wt, "main")).resolves.toEqual({ ok: true });
    expect(await syncOperationInProgress(wt)).toBe(false);
    await expect(
      git(wt, [
        "merge-base",
        "--is-ancestor",
        await headSha(repo, "main"),
        "HEAD",
      ]),
    ).resolves.toBeDefined();
  });

  it("addWorktreeForBranch attaches an existing branch and refuses one already checked out", async () => {
    await git(repo, ["branch", "feature/attach", "main"]);
    const wt = join(root, "attach-wt");

    await addWorktreeForBranch(repo, wt, "feature/attach");

    expect(
      (await git(wt, ["symbolic-ref", "--short", "HEAD"])).stdout.trim(),
    ).toBe("feature/attach");

    const wt2 = join(root, "attach-wt-2");

    await expect(
      addWorktreeForBranch(repo, wt2, "feature/attach"),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("addWorktreeForBranch refuses a missing local branch without fetching", async () => {
    const wt = join(root, "attach-missing-wt");

    await expect(
      addWorktreeForBranch(repo, wt, "does/not-exist"),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("branchHasUpstream distinguishes a tracked branch from an untracked one", async () => {
    await git(repo, ["branch", "track-me", "main"]);
    await git(repo, ["branch", "--set-upstream-to=main", "track-me"]);

    expect(await branchHasUpstream(repo, "track-me")).toBe(true);
    expect(await branchHasUpstream(repo, "main")).toBe(false);
  });
});
