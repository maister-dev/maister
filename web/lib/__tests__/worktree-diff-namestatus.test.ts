// M22 Phase 5 (T5.1, RED): failing unit tests for the changed-files summary CORE.
//
// Contract (NOT yet built — RED on the missing export):
//   web/lib/worktree.ts
//     export interface DiffFileEntry { path: string; status: string }
//     export async function diffNameStatus(args: {
//       worktreePath: string; baseRef: string; branch: string;
//     }): Promise<DiffFileEntry[]>
//
//       - validate worktreePath (absolutePathSchema), baseRef (gitRefSchema),
//         branch (branchNameSchema)
//       - `git diff --name-status --no-color --end-of-options ${baseRef}..${branch}`
//         (2-dot, matching diffRunWorkspace's `base..branch` — the literal
//          stored-base -> branch tree delta, NOT a 3-dot merge-base range)
//       - parse each line "<STATUS>\t<path>":
//           status = first char of the status token (A/M/D/R/C)
//           path   = for a rename/copy line (3 tab-fields `R100\told\tnew`)
//                    the NEW path (last field), else the single path field.
//     export async function diffChangeStats(args):
//       - use git `--numstat` + `--name-status` for lightweight per-file counts
//         without preparing the rendered diff.
//
// Built against a REAL temp git repo via the worktree-range / worktree-tree
// harness so the parse is exercised over actual git output, not a mock.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  diffChangeStats,
  diffNameStatus,
  diffRunWorkspace,
  diffWorkingTreeChangeStats,
} from "@/lib/worktree";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });

  return stdout;
}

describe("diffNameStatus against a real temp git repo", () => {
  let repo: string;
  let baseSha: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "worktree-namestatus-"));

    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "user.email", "test@maister.local");
    await git(repo, "config", "user.name", "Test");
    await git(repo, "config", "commit.gpgsign", "false");
    await git(repo, "config", "diff.renames", "true");

    // Base commit on main: keep.txt (modified later), drop.txt (deleted later),
    // old-name.txt (renamed later). Each line distinct so the rename detector
    // matches old-name -> new-name on content identity.
    await writeFile(join(repo, "keep.txt"), "original keep\n");
    await writeFile(join(repo, "drop.txt"), "doomed\n");
    await writeFile(
      join(repo, "old-name.txt"),
      "stable content for rename detection\n",
    );
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "base commit");
    baseSha = (await git(repo, "rev-parse", "HEAD")).trim();

    await git(repo, "checkout", "-q", "-b", "feature");

    // ADD a brand-new file.
    await writeFile(join(repo, "added.txt"), "new file\n");
    // MODIFY keep.txt.
    await writeFile(join(repo, "keep.txt"), "modified keep\n");
    // DELETE drop.txt.
    await rm(join(repo, "drop.txt"));
    // RENAME old-name.txt -> new-name.txt (git records it via `git mv`).
    await git(repo, "mv", "old-name.txt", "new-name.txt");
    // ADD a binary file so numstat reports `- -`.
    await writeFile(join(repo, "binary.bin"), new Uint8Array([0, 1, 2, 3]));

    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "add/modify/delete/rename");
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("reports an added file with status 'A' and its path", async () => {
    const entries = await diffNameStatus({
      worktreePath: repo,
      baseRef: baseSha,
      branch: "feature",
    });
    const added = entries.find((e) => e.path === "added.txt");

    expect(added).toBeDefined();
    expect(added?.status).toBe("A");
  });

  it("reports a modified file with status 'M' and its path", async () => {
    const entries = await diffNameStatus({
      worktreePath: repo,
      baseRef: baseSha,
      branch: "feature",
    });
    const modified = entries.find((e) => e.path === "keep.txt");

    expect(modified).toBeDefined();
    expect(modified?.status).toBe("M");
  });

  it("reports a deleted file with status 'D' and its path", async () => {
    const entries = await diffNameStatus({
      worktreePath: repo,
      baseRef: baseSha,
      branch: "feature",
    });
    const deleted = entries.find((e) => e.path === "drop.txt");

    expect(deleted).toBeDefined();
    expect(deleted?.status).toBe("D");
  });

  it("reports a renamed file with status 'R' and the NEW path", async () => {
    const entries = await diffNameStatus({
      worktreePath: repo,
      baseRef: baseSha,
      branch: "feature",
    });
    const renamed = entries.find((e) => e.status === "R");

    expect(renamed).toBeDefined();
    // The path is the NEW name (the last tab-field of an `R100\told\tnew` line),
    // never the old name.
    expect(renamed?.path).toBe("new-name.txt");
    expect(entries.some((e) => e.path === "old-name.txt")).toBe(false);
  });

  it("resolves a symbolic baseRef ('main') the same as the base SHA", async () => {
    const entries = await diffNameStatus({
      worktreePath: repo,
      baseRef: "main",
      branch: "feature",
    });

    expect(
      entries.some((e) => e.path === "added.txt" && e.status === "A"),
    ).toBe(true);
  });

  it("validates inputs: a traversal branch ('../evil') throws MaisterError", async () => {
    await expect(
      diffNameStatus({
        worktreePath: repo,
        baseRef: baseSha,
        branch: "../evil",
      }),
    ).rejects.toBeInstanceOf(MaisterError);
  });
});

describe("diffChangeStats against a real temp git repo", () => {
  let repo: string;
  let baseSha: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "worktree-changestats-"));

    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "user.email", "test@maister.local");
    await git(repo, "config", "user.name", "Test");
    await git(repo, "config", "commit.gpgsign", "false");
    await git(repo, "config", "diff.renames", "true");

    await writeFile(join(repo, "keep.txt"), "original keep\n");
    await writeFile(join(repo, "drop.txt"), "doomed\n");
    await writeFile(
      join(repo, "old-name.txt"),
      "stable content for rename detection\n",
    );
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "base commit");
    baseSha = (await git(repo, "rev-parse", "HEAD")).trim();

    await git(repo, "checkout", "-q", "-b", "feature");
    await writeFile(join(repo, "added.txt"), "new file\n");
    await writeFile(join(repo, "keep.txt"), "modified keep\n");
    await rm(join(repo, "drop.txt"));
    await git(repo, "mv", "old-name.txt", "new-name.txt");
    await writeFile(join(repo, "binary.bin"), new Uint8Array([0, 1, 2, 3]));
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "add/modify/delete/rename/binary");
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("reports additions and deletions without preparing a rendered diff", async () => {
    const entries = await diffChangeStats({
      worktreePath: repo,
      baseRef: baseSha,
      branch: "feature",
    });

    expect(entries.find((e) => e.path === "added.txt")).toMatchObject({
      status: "A",
      additions: 1,
      deletions: 0,
      binary: false,
    });
    expect(entries.find((e) => e.path === "keep.txt")).toMatchObject({
      status: "M",
      additions: 1,
      deletions: 1,
      binary: false,
    });
    expect(entries.find((e) => e.path === "drop.txt")).toMatchObject({
      status: "D",
      additions: 0,
      deletions: 1,
      binary: false,
    });
  });

  it("reports rename-only files with the new path and zero textual counts", async () => {
    const entries = await diffChangeStats({
      worktreePath: repo,
      baseRef: baseSha,
      branch: "feature",
    });
    const renamed = entries.find((e) => e.status === "R");

    expect(renamed).toMatchObject({
      path: "new-name.txt",
      oldPath: "old-name.txt",
      additions: 0,
      deletions: 0,
      binary: false,
    });
  });

  it("marks binary file changes without inventing line counts", async () => {
    const entries = await diffChangeStats({
      worktreePath: repo,
      baseRef: baseSha,
      branch: "feature",
    });

    expect(entries.find((e) => e.path === "binary.bin")).toMatchObject({
      status: "A",
      additions: 0,
      deletions: 0,
      binary: true,
    });
  });

  it("returns an empty list for an empty branch diff", async () => {
    await expect(
      diffChangeStats({
        worktreePath: repo,
        baseRef: baseSha,
        branch: "main",
      }),
    ).resolves.toEqual([]);
  });
});

describe("diffWorkingTreeChangeStats against a dirty worktree", () => {
  let repo: string;
  let statusBefore: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "worktree-dirty-changestats-"));

    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "user.email", "test@maister.local");
    await git(repo, "config", "user.name", "Test");
    await git(repo, "config", "commit.gpgsign", "false");
    await writeFile(join(repo, "tracked.txt"), "before\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "base commit");

    await writeFile(join(repo, "tracked.txt"), "after\n");
    await writeFile(join(repo, "untracked.txt"), "fresh\n");
    statusBefore = await git(
      repo,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    );
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("summarizes tracked and untracked changes without mutating the real index", async () => {
    const entries = await diffWorkingTreeChangeStats(repo);
    const statusAfter = await git(
      repo,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    );

    expect(statusAfter).toBe(statusBefore);
    expect(entries.find((e) => e.path === "tracked.txt")).toMatchObject({
      status: "M",
      additions: 1,
      deletions: 1,
      binary: false,
    });
    expect(entries.find((e) => e.path === "untracked.txt")).toMatchObject({
      status: "A",
      additions: 1,
      deletions: 0,
      binary: false,
    });
  });
});

// Regression (Codex adversarial review): the workbench diff MUST report the full
// stored-base -> branch delta, even when the run branch was rewritten (rebase/
// reset) so its stored base is no longer an ancestor. A 3-dot range
// (base...branch) would diff from merge-base(base, branch) and silently OMIT a
// branch change that happens to match that older merge-base; the 2-dot range
// (base..branch) reports the literal tree delta. Here `base` (otherbase) and the
// branch diverge at the root, and the branch resets `shared.txt` back to the
// root content — invisible under 3-dot, visible (M) under 2-dot.
describe("diffNameStatus / diffRunWorkspace — base not an ancestor of branch (2-dot)", () => {
  let repo2: string;
  let baseSha2: string;

  beforeAll(async () => {
    repo2 = await mkdtemp(join(tmpdir(), "worktree-namestatus-divergent-"));

    await git(repo2, "init", "-q", "-b", "main");
    await git(repo2, "config", "user.email", "test@maister.local");
    await git(repo2, "config", "user.name", "Test");
    await git(repo2, "config", "commit.gpgsign", "false");

    // Root: shared.txt = "v0".
    await writeFile(join(repo2, "shared.txt"), "v0\n");
    await git(repo2, "add", "-A");
    await git(repo2, "commit", "-q", "-m", "root");
    const rootSha = (await git(repo2, "rev-parse", "HEAD")).trim();

    // Stored base line (otherbase): shared.txt = "v1". NOT an ancestor of feature.
    await git(repo2, "checkout", "-q", "-b", "otherbase");
    await writeFile(join(repo2, "shared.txt"), "v1\n");
    await git(repo2, "add", "-A");
    await git(repo2, "commit", "-q", "-m", "base diverges");
    baseSha2 = (await git(repo2, "rev-parse", "HEAD")).trim();

    // Feature forked from ROOT (not from otherbase): resets shared.txt back to
    // "v0" (matches root) and adds feature.txt.
    await git(repo2, "checkout", "-q", "-b", "feature", rootSha);
    await writeFile(join(repo2, "feature.txt"), "f\n");
    await git(repo2, "add", "-A");
    await git(repo2, "commit", "-q", "-m", "feature work");
  });

  afterAll(async () => {
    await rm(repo2, { recursive: true, force: true });
  });

  it("name-status reports BOTH the added file and the base-relative shared.txt change", async () => {
    const entries = await diffNameStatus({
      worktreePath: repo2,
      baseRef: baseSha2,
      branch: "feature",
    });

    expect(entries).toEqual(
      expect.arrayContaining([
        { path: "feature.txt", status: "A" },
        { path: "shared.txt", status: "M" },
      ]),
    );
  });

  it("raw diff includes the shared.txt change a 3-dot range would have hidden", async () => {
    const diff = await diffRunWorkspace({
      projectRepoPath: repo2,
      baseCommit: baseSha2,
      branch: "feature",
    });

    expect(diff.truncated).toBe(false);
    expect(diff.text).toContain("shared.txt");
    expect(diff.text).toContain("feature.txt");
    // The literal base(v1) -> branch(v0) delta for shared.txt.
    expect(diff.text).toContain("-v1");
    expect(diff.text).toContain("+v0");
  });
});
