import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listBranches, resolveBaseCommit } from "@/lib/worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, message: string): string {
  git(
    cwd,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--allow-empty",
    "-m",
    message,
  );

  return git(cwd, "rev-parse", "HEAD").toLowerCase();
}

// Fixture: a bare `origin` with `main` + `feature`; a `clone` whose local `main`
// is one commit BEHIND origin/main (origin advanced after the clone), plus a
// local-only `wip` branch. This is exactly the "stale local checkout" launch
// guards against.
describe("listBranches / resolveBaseCommit (remote-aware)", () => {
  let root: string;
  let clone: string;
  let seedSha: string;
  let aheadSha: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "worktree-remote-branches-"));

    const work = join(root, "work");

    await mkdir(work, { recursive: true });
    git(work, "init", "--initial-branch=main");
    seedSha = commit(work, "seed");
    git(work, "branch", "feature");

    const bare = join(root, "src.git");

    git(root, "clone", "--bare", work, bare);

    clone = join(root, "clone");
    git(root, "clone", bare, clone);
    git(clone, "branch", "wip");

    // Advance origin/main past the clone's local main via a second clone.
    const pusher = join(root, "pusher");

    git(root, "clone", bare, pusher);
    aheadSha = commit(pusher, "ahead");
    git(pusher, "push", "origin", "main");

    git(clone, "fetch", "origin");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists only local heads by default", async () => {
    expect([...(await listBranches(clone))].sort()).toEqual(["main", "wip"]);
  });

  it("includes origin branches (collapsed, no origin/HEAD) when asked", async () => {
    const branches = await listBranches(clone, { includeRemotes: true });

    // `feature` is remote-only; `main` is local+remote, deduped to one entry.
    expect([...branches].sort()).toEqual(["feature", "main", "wip"]);
    expect(branches).not.toContain("origin/HEAD");
    expect(branches).not.toContain("origin/main");
    expect(branches.filter((b) => b === "main")).toHaveLength(1);
  });

  it("resolveBaseCommit uses the local ref by default", async () => {
    expect(
      await resolveBaseCommit({ projectRepoPath: clone, baseRef: "main" }),
    ).toBe(seedSha);
  });

  it("resolveBaseCommit prefers origin/<base> when preferRemote is set", async () => {
    expect(
      await resolveBaseCommit({
        projectRepoPath: clone,
        baseRef: "main",
        preferRemote: "origin",
      }),
    ).toBe(aheadSha);
  });

  it("resolveBaseCommit preferRemote resolves a remote-only branch", async () => {
    expect(
      await resolveBaseCommit({
        projectRepoPath: clone,
        baseRef: "feature",
        preferRemote: "origin",
      }),
    ).toBe(seedSha);
  });
});
