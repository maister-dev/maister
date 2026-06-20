import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { autoResolveDirtyAtReview } from "@/lib/runs/dirty-resolution";

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

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "dirty-"));
  await git(["init", "-q", "-b", "main"]);
  await writeFile(join(repo, "README.md"), "base\n");
  await git(["add", "-A"]);
  await git(["commit", "--no-verify", "-m", "base"]);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("autoResolveDirtyAtReview (C3 — policy-driven dirty resolution)", () => {
  it("proceed: records proceed, leaves the dirt uncommitted", async () => {
    await writeFile(join(repo, "wip.txt"), "uncommitted\n");

    const result = await autoResolveDirtyAtReview({
      worktreePath: repo,
      policy: "proceed",
      nodeId: "review",
    });

    expect(result).toBe("proceed");
    // Still dirty — proceed never commits.
    expect(await git(["status", "--porcelain"])).toContain("wip.txt");
  });

  it("commit: snapshots the dirt into a commit, leaving a clean tree", async () => {
    await writeFile(join(repo, "wip.txt"), "uncommitted\n");

    const result = await autoResolveDirtyAtReview({
      worktreePath: repo,
      policy: "commit",
      nodeId: "review",
    });

    expect(result).toBe("commit");
    expect(await git(["status", "--porcelain"])).toBe("");
    expect(await git(["show", "HEAD:wip.txt"])).toBe("uncommitted");
  });

  it("ask: returns null (interactive banner), tree untouched", async () => {
    await writeFile(join(repo, "wip.txt"), "uncommitted\n");

    const result = await autoResolveDirtyAtReview({
      worktreePath: repo,
      policy: "ask",
      nodeId: "review",
    });

    expect(result).toBeNull();
    expect(await git(["status", "--porcelain"])).toContain("wip.txt");
  });

  it("a clean tree → null even under a non-ask policy", async () => {
    const result = await autoResolveDirtyAtReview({
      worktreePath: repo,
      policy: "proceed",
      nodeId: "review",
    });

    expect(result).toBeNull();
  });

  it("a null worktree → null; a non-git path → null (never throws)", async () => {
    expect(
      await autoResolveDirtyAtReview({
        worktreePath: null,
        policy: "commit",
        nodeId: "review",
      }),
    ).toBeNull();

    const nonGit = await mkdtemp(join(tmpdir(), "nongit-"));

    expect(
      await autoResolveDirtyAtReview({
        worktreePath: nonGit,
        policy: "proceed",
        nodeId: "review",
      }),
    ).toBeNull();

    await rm(nonGit, { recursive: true, force: true });
  });
});
