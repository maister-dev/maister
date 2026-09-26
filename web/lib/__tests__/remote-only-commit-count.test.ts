// ADR-181 (C): a merge on the publication is not free to drop. A provider's
// "Update branch" merge that only joins its parents loses nothing when both
// parents stay. But a merge that resolves a conflict, or carries an edit of its
// own, holds changes that exist nowhere else.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { remoteOnlyCommitCount } from "@/lib/worktree";

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

async function commit(file: string, content: string): Promise<string> {
  await writeFile(join(repo, file), content);
  await git(["add", "-A"]);
  await git(["commit", "--no-verify", "-q", "-m", file]);

  return git(["rev-parse", "HEAD"]);
}

// The publication: the run's own commit, merged with the target on the remote.
async function publicationMerge(
  opts: { conflict?: boolean; extraEdit?: boolean } = {},
): Promise<string> {
  await git(["checkout", "-q", "-b", "pub", "run"]);
  await git(["merge", "-q", "--no-edit", "main"]).catch(async () => {
    await writeFile(join(repo, "shared.txt"), "resolved\n");
    await git(["add", "-A"]);
    await git(["commit", "--no-verify", "-q", "--no-edit"]);
  });

  if (opts.extraEdit) {
    await writeFile(join(repo, "fixup.txt"), "reviewer\n");
    await git(["add", "-A"]);
    await git(["commit", "--amend", "--no-verify", "-q", "--no-edit"]);
  }

  const head = await git(["rev-parse", "HEAD"]);

  await git(["checkout", "-q", "run"]);

  return head;
}

function count(remoteSha: string): Promise<number> {
  return remoteOnlyCommitCount({
    projectRepoPath: repo,
    localBranch: "run",
    remoteSha,
    keptRefs: ["main"],
  });
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "remote-only-"));
  await git(["init", "-q", "-b", "main"]);
  await commit("shared.txt", "base\n");
  await git(["checkout", "-q", "-b", "run"]);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("remoteOnlyCommitCount and merges", () => {
  it("does not count a merge that only joins parents the push keeps", async () => {
    await commit("run.txt", "run\n");
    await git(["checkout", "-q", "main"]);
    await commit("target.txt", "target\n");
    await git(["checkout", "-q", "run"]);

    expect(await count(await publicationMerge())).toBe(0);
  });

  it("counts a merge that carries an edit of its own", async () => {
    await commit("run.txt", "run\n");
    await git(["checkout", "-q", "main"]);
    await commit("target.txt", "target\n");
    await git(["checkout", "-q", "run"]);

    expect(await count(await publicationMerge({ extraEdit: true }))).toBe(1);
  });

  it("counts a merge that resolved a conflict", async () => {
    await commit("shared.txt", "run\n");
    await git(["checkout", "-q", "main"]);
    await commit("shared.txt", "target\n");
    await git(["checkout", "-q", "run"]);

    expect(await count(await publicationMerge({ conflict: true }))).toBe(1);
  });
});
