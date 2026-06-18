import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDefaultBranch } from "@/lib/worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, message: string): void {
  git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", message);
}

// getDefaultBranch resolves a repo's default branch in three tiers:
//   1. refs/remotes/origin/HEAD (strip "origin/")  — a clone with a remote
//   2. rev-parse --abbrev-ref HEAD                  — local branch, no origin
//   3. literal "main"                               — not a repo / unresolved
describe("getDefaultBranch", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "worktree-default-branch-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("tier 1: reads origin/HEAD when a clone has a remote default", async () => {
    // Distinctive default ("trunk") proves tier 1 read origin/HEAD, not the
    // tier-3 "main" fallback.
    const work = join(root, "work");

    await mkdir(work, { recursive: true });
    git(work, "init", "--initial-branch=trunk");
    commit(work, "seed");

    const bare = join(root, "src.git");

    git(root, "clone", "--bare", work, bare);

    const clone = join(root, "clone");

    git(root, "clone", bare, clone);

    expect(await getDefaultBranch(clone)).toBe("trunk");
  });

  it("tier 2: falls back to the current local branch when there is no origin", async () => {
    const dir = join(root, "local");

    await mkdir(dir, { recursive: true });
    git(dir, "init", "--initial-branch=develop");
    commit(dir, "seed");

    expect(await getDefaultBranch(dir)).toBe("develop");
  });

  it('tier 3: returns "main" for a non-git directory', async () => {
    const dir = join(root, "plain");

    await mkdir(dir, { recursive: true });

    expect(await getDefaultBranch(dir)).toBe("main");
  });
});
