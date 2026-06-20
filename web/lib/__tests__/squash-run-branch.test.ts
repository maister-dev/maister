import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { squashRunBranch } from "@/lib/worktree";

const exec = promisify(execFile);

let repo: string;

async function git(args: string[]): Promise<string> {
  const { stdout } = await exec(
    "git",
    ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { maxBuffer: 1 << 20 },
  );

  return stdout.trim();
}

async function commit(
  file: string,
  content: string,
  msg: string,
): Promise<void> {
  await writeFile(join(repo, file), content);
  await git(["add", "-A"]);
  await git(["commit", "--no-verify", "-m", msg]);
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "squash-"));
  await git(["init", "-q", "-b", "main"]);
  await commit("README.md", "base\n", "base");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("squashRunBranch (C2 — squash-on-promote, tree-preserving)", () => {
  it("collapses N commits into one while preserving the tree byte-for-byte", async () => {
    const base = await git(["rev-parse", "HEAD"]);

    await commit("a.txt", "one\n", "node a attempt 1");
    await commit("a.txt", "two\n", "node a attempt 2");
    await commit("b.txt", "three\n", "node b");

    const treeBefore = await git(["rev-parse", "HEAD^{tree}"]);

    const result = await squashRunBranch({
      worktreePath: repo,
      baseCommit: base,
      message: "maister squashed",
    });

    expect(result.squashed).toBe(true);
    expect(result.collapsed).toBe(3);

    // Exactly one commit now sits between base and HEAD...
    expect(await git(["rev-list", "--count", `${base}..HEAD`])).toBe("1");
    // ...the final tree is byte-identical (the merged content is unchanged)...
    expect(await git(["rev-parse", "HEAD^{tree}"])).toBe(treeBefore);
    // ...and the file contents are intact.
    expect(await git(["show", "HEAD:a.txt"])).toBe("two");
    expect(await git(["show", "HEAD:b.txt"])).toBe("three");
  });

  it("is a no-op when the branch has <=1 commit beyond base", async () => {
    const base = await git(["rev-parse", "HEAD"]);

    await commit("a.txt", "only\n", "single");

    const result = await squashRunBranch({
      worktreePath: repo,
      baseCommit: base,
      message: "maister squashed",
    });

    expect(result.squashed).toBe(false);
    expect(result.reason).toBe("no-commits");
    // History untouched.
    expect(await git(["rev-list", "--count", `${base}..HEAD`])).toBe("1");
  });

  it("never throws on a git failure — returns git-error so the caller keeps_all", async () => {
    const result = await squashRunBranch({
      worktreePath: repo,
      // A well-formed but non-existent SHA → rev-list fails inside the guard.
      baseCommit: "0".repeat(40),
      message: "maister squashed",
    });

    expect(result.squashed).toBe(false);
    expect(result.reason).toBe("git-error");
  });

  it("preserves uncommitted (unstaged) worktree changes through the squash", async () => {
    const base = await git(["rev-parse", "HEAD"]);

    await commit("a.txt", "one\n", "c1");
    await commit("a.txt", "two\n", "c2");
    // Dirty the worktree (unstaged) — must survive the soft-reset squash.
    await writeFile(join(repo, "a.txt"), "dirty\n");

    const result = await squashRunBranch({
      worktreePath: repo,
      baseCommit: base,
      message: "maister squashed",
    });

    expect(result.squashed).toBe(true);
    // The committed tree is the last committed state ("two"), dirt stays unstaged.
    expect(await git(["show", "HEAD:a.txt"])).toBe("two");
    const porcelain = await git(["status", "--porcelain"]);

    expect(porcelain).toContain("a.txt");
  });
});
