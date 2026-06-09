import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  addWorktree,
  branchExists,
  diffRunWorkspace,
  listBranches,
  promoteLocalMerge,
  removeOwnedWorktree,
  removeWorktree,
  resolveBaseCommit,
} from "@/lib/worktree";

const execFileAsync = promisify(execFile);

let root: string;
let repo: string;

beforeEach(async () => {
  root = join(tmpdir(), `worktree-test-${randomUUID()}`);
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

describe("worktree git helpers", () => {
  it("rejects unsafe base refs before invoking git", async () => {
    await expect(
      resolveBaseCommit({ projectRepoPath: repo, baseRef: "--bad" }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("resolves base commit, adds worktree from start point, and lists branches", async () => {
    const wt = join(root, "scratch-wt");
    const baseCommit = await resolveBaseCommit({
      projectRepoPath: repo,
      baseRef: "main",
    });

    await addWorktree({
      projectRepoPath: repo,
      branch: "scratch/test",
      worktreePath: wt,
      startPoint: "main",
    });

    const { stdout } = await git(wt, ["rev-parse", "HEAD"]);
    const branches = await listBranches(repo);

    expect(stdout.trim()).toBe(baseCommit);
    expect(
      await branchExists({ projectRepoPath: repo, branch: "scratch/test" }),
    ).toBe(true);
    expect(branches).toContain("main");
    expect(branches).toContain("scratch/test");
  });

  it("returns diff from base commit to scratch branch", async () => {
    const wt = join(root, "diff-wt");
    const baseCommit = await resolveBaseCommit({
      projectRepoPath: repo,
      baseRef: "main",
    });

    await addWorktree({
      projectRepoPath: repo,
      branch: "scratch/diff",
      worktreePath: wt,
      startPoint: "main",
    });
    await writeFile(join(wt, "file.txt"), "base\nscratch\n");
    await git(wt, ["add", "file.txt"]);
    await git(wt, ["commit", "-m", "scratch change"]);

    const diff = await diffRunWorkspace({
      projectRepoPath: repo,
      baseCommit,
      branch: "scratch/diff",
    });

    expect(diff.truncated).toBe(false);
    expect(diff.text).toContain("+scratch");
  });

  it("aborts merge and reports conflict when local promotion cannot merge", async () => {
    await git(repo, ["checkout", "-b", "scratch/conflict"]);
    await writeFile(join(repo, "file.txt"), "source\n");
    await git(repo, ["commit", "-am", "source change"]);
    await git(repo, ["checkout", "main"]);
    await writeFile(join(repo, "file.txt"), "target\n");
    await git(repo, ["commit", "-am", "target change"]);

    await expect(
      promoteLocalMerge({
        projectRepoPath: repo,
        sourceBranch: "scratch/conflict",
        targetBranch: "main",
      }),
    ).rejects.toBeInstanceOf(MaisterError);

    await expect(
      git(repo, ["rev-parse", "--verify", "MERGE_HEAD"]),
    ).rejects.toThrow();
  });

  it("refuses to remove a worktree outside the allowed root", async () => {
    const wt = join(root, "owned", "scratch-wt");

    await mkdir(join(root, "owned"), { recursive: true });
    await addWorktree({
      projectRepoPath: repo,
      branch: "scratch/remove",
      worktreePath: wt,
      startPoint: "main",
    });

    await expect(
      removeOwnedWorktree({
        projectRepoPath: repo,
        worktreePath: wt,
        allowedRoot: join(root, "other-root"),
        force: true,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    expect(
      await branchExists({ projectRepoPath: repo, branch: "scratch/remove" }),
    ).toBe(true);

    await removeWorktree({
      projectRepoPath: repo,
      worktreePath: wt,
      force: true,
    });
  });
});
