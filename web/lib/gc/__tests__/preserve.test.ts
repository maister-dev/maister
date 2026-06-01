// M19 Phase 4 (T4.1): preserveWorktree — git-only, NO DB. Codex F1 says
// preserve EVERYTHING (tracked + untracked + committed divergence) BEFORE any
// removal, and NEVER throw into a removal (any git failure → {ok:false} so the
// caller skips removeOwnedWorktree). Order:
//   (1) statusPorcelain(worktree)
//   (2) dirty → git add -A && git commit --no-verify -m "maister: GC snapshot
//       of <runId>" (captures tracked + untracked)
//   (3) dirty OR logRange(base..branch) non-empty → git branch -f
//       maister/archive/<runId> HEAD; archivePush + remote → push origin
//       → {ok:true, archivedBranch, archivedAt, snapshotted:dirty}
//   (4) clean AND no divergence → {ok:true} (nothing preserved, no branch)
//   (5) any git failure → {ok:false}
// Real-git harness mirrors web/lib/__tests__/worktree-range.test.ts.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { preserveWorktree } from "@/lib/gc/preserve";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });

  return stdout;
}

// Build a fresh repo on `main` with one base commit, then check out a
// feature branch. Returns the repo path, the base SHA (merge-base anchor),
// and the chosen run id / branch.
async function makeRepo(): Promise<{
  repo: string;
  baseSha: string;
  branch: string;
  runId: string;
}> {
  const repo = await mkdtemp(join(tmpdir(), "gc-preserve-"));

  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@maister.local");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "commit.gpgsign", "false");

  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base commit");
  const baseSha = (await git(repo, "rev-parse", "HEAD")).trim();

  const branch = "maister/run-abc";

  await git(repo, "checkout", "-q", "-b", branch);

  return { repo, baseSha, branch, runId: "run-abc" };
}

const created: string[] = [];

beforeEach(() => {
  created.length = 0;
});

afterEach(async () => {
  await Promise.all(
    created.map((p) => rm(p, { recursive: true, force: true })),
  );
});

async function track(p: string): Promise<string> {
  created.push(p);

  return p;
}

describe("preserveWorktree (real git)", () => {
  it("dirty tracked change → snapshot commit captures it + archive branch (snapshotted:true)", async () => {
    const { repo, baseSha, branch, runId } = await makeRepo();

    await track(repo);

    // Modify a tracked file so the worktree is dirty (porcelain non-empty)
    // with no new commit yet.
    await writeFile(join(repo, "base.txt"), "base mutated\n");

    const result = await preserveWorktree({
      worktreePath: repo,
      parentRepoPath: repo,
      branch,
      baseRef: baseSha,
      runId,
    });

    expect(result.ok).toBe(true);
    expect(result.snapshotted).toBe(true);
    expect(result.archivedBranch).toBe(`maister/archive/${runId}`);
    expect(result.archivedAt).toBeInstanceOf(Date);

    // The archive branch exists and its tip tree carries the mutated content.
    const showRef = await git(
      repo,
      "show-ref",
      "--verify",
      `refs/heads/maister/archive/${runId}`,
    );

    expect(showRef.trim().length).toBeGreaterThan(0);

    const archived = await git(
      repo,
      "show",
      `maister/archive/${runId}:base.txt`,
    );

    expect(archived).toContain("base mutated");

    // After the snapshot the worktree is clean (the commit captured the edit).
    const porcelain = await git(repo, "status", "--porcelain=v1");

    expect(porcelain.trim()).toBe("");
  });

  it("untracked file → captured in the snapshot (archive branch tree contains it)", async () => {
    const { repo, baseSha, branch, runId } = await makeRepo();

    await track(repo);

    // A brand-new untracked file is the case `git branch -f` alone would
    // silently drop — the snapshot commit (git add -A) must capture it.
    await writeFile(join(repo, "untracked-note.txt"), "scratch work\n");

    const result = await preserveWorktree({
      worktreePath: repo,
      parentRepoPath: repo,
      branch,
      baseRef: baseSha,
      runId,
    });

    expect(result.ok).toBe(true);
    expect(result.snapshotted).toBe(true);
    expect(result.archivedBranch).toBe(`maister/archive/${runId}`);

    const archived = await git(
      repo,
      "show",
      `maister/archive/${runId}:untracked-note.txt`,
    );

    expect(archived).toContain("scratch work");
  });

  it("committed divergence on a clean tree → archive branch, no snapshot (snapshotted:false)", async () => {
    const { repo, baseSha, branch, runId } = await makeRepo();

    await track(repo);

    // A real commit beyond base, but the working tree is clean.
    await writeFile(join(repo, "feature.txt"), "feature\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "add feature");
    const headBefore = (await git(repo, "rev-parse", "HEAD")).trim();

    const result = await preserveWorktree({
      worktreePath: repo,
      parentRepoPath: repo,
      branch,
      baseRef: baseSha,
      runId,
    });

    expect(result.ok).toBe(true);
    expect(result.snapshotted).toBe(false);
    expect(result.archivedBranch).toBe(`maister/archive/${runId}`);

    // No snapshot commit was created — HEAD is unchanged.
    const headAfter = (await git(repo, "rev-parse", "HEAD")).trim();

    expect(headAfter).toBe(headBefore);

    // The archive branch points at the committed divergence.
    const archiveSha = (
      await git(repo, "rev-parse", `maister/archive/${runId}`)
    ).trim();

    expect(archiveSha).toBe(headBefore);
  });

  it("clean tree with no divergence → {ok:true} and NO archive branch", async () => {
    const { repo, baseSha, branch, runId } = await makeRepo();

    await track(repo);

    // Branch is at base, working tree clean — nothing to preserve.
    const result = await preserveWorktree({
      worktreePath: repo,
      parentRepoPath: repo,
      branch,
      baseRef: baseSha,
      runId,
    });

    expect(result.ok).toBe(true);
    expect(result.archivedBranch).toBeUndefined();
    expect(result.snapshotted).toBeFalsy();

    // No archive branch was created.
    await expect(
      git(repo, "rev-parse", "--verify", `refs/heads/maister/archive/${runId}`),
    ).rejects.toBeTruthy();
  });

  it("archivePush:true with a remote → archive branch pushed to the bare remote", async () => {
    const { repo, baseSha, branch, runId } = await makeRepo();

    await track(repo);

    const bare = await track(
      await mkdtemp(join(tmpdir(), "gc-preserve-bare-")),
    );

    await git(bare, "init", "-q", "--bare", "-b", "main");
    await git(repo, "remote", "add", "origin", bare);

    await writeFile(join(repo, "feature.txt"), "feature\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "add feature");

    const result = await preserveWorktree({
      worktreePath: repo,
      parentRepoPath: repo,
      branch,
      baseRef: baseSha,
      runId,
      archivePush: true,
    });

    expect(result.ok).toBe(true);
    expect(result.archivedBranch).toBe(`maister/archive/${runId}`);

    // The archive branch now exists on the bare remote.
    const remoteRef = await git(
      bare,
      "show-ref",
      "--verify",
      `refs/heads/maister/archive/${runId}`,
    );

    expect(remoteRef.trim().length).toBeGreaterThan(0);
  });

  it("idempotent: re-running on a clean tree is a no-op ({ok:true})", async () => {
    const { repo, baseSha, branch, runId } = await makeRepo();

    await track(repo);

    await writeFile(join(repo, "feature.txt"), "feature\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "add feature");

    const first = await preserveWorktree({
      worktreePath: repo,
      parentRepoPath: repo,
      branch,
      baseRef: baseSha,
      runId,
    });

    expect(first.ok).toBe(true);

    // Working tree is clean after the first call; the second call re-runs
    // safely and still reports ok with no new snapshot.
    const second = await preserveWorktree({
      worktreePath: repo,
      parentRepoPath: repo,
      branch,
      baseRef: baseSha,
      runId,
    });

    expect(second.ok).toBe(true);
    expect(second.snapshotted).toBe(false);
  });

  it("git failure (non-existent worktree path) → {ok:false}, never throws", async () => {
    const result = await preserveWorktree({
      worktreePath: "/nonexistent/maister/gc/worktree",
      parentRepoPath: "/nonexistent/maister/gc/parent",
      branch: "maister/run-missing",
      baseRef: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      runId: "run-missing",
    });

    expect(result.ok).toBe(false);
  });

  it("never writes a commit/merge onto the parent repo's main branch", async () => {
    const { repo, baseSha, branch, runId } = await makeRepo();

    await track(repo);

    const mainTipBefore = (
      await git(repo, "rev-parse", "refs/heads/main")
    ).trim();

    await writeFile(join(repo, "feature.txt"), "feature\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "add feature");

    await preserveWorktree({
      worktreePath: repo,
      parentRepoPath: repo,
      branch,
      baseRef: baseSha,
      runId,
    });

    const mainTipAfter = (
      await git(repo, "rev-parse", "refs/heads/main")
    ).trim();

    expect(mainTipAfter).toBe(mainTipBefore);
  });
});
