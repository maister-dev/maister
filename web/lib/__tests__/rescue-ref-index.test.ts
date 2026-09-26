// ADR-181 D8: the rescue keeps the index as the operator left it. A file
// staged at one version and edited to another, or staged and since deleted
// from the tree, exists only in the index. An `add -A` over a copy of it would
// rescue neither, and the reset that follows drops the only index that had them.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeRescueRef } from "@/lib/worktree";

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

async function commit(file: string, content: string): Promise<void> {
  await writeFile(join(repo, file), content);
  await git(["add", "-A"]);
  await git(["commit", "--no-verify", "-q", "-m", file]);
}

async function parents(ref: string): Promise<string[]> {
  return (await git(["rev-list", "--parents", "-n", "1", ref]))
    .split(" ")
    .slice(1);
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "rescue-index-"));
  await git(["init", "-q", "-b", "main"]);
  await commit("a.txt", "base\n");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("writeRescueRef keeps the index", () => {
  it("anchors the index as it stood beside the tree it rescues, past the reset", async () => {
    await writeFile(join(repo, "a.txt"), "staged\n");
    await git(["add", "a.txt"]);
    await writeFile(join(repo, "a.txt"), "working\n");
    await writeFile(join(repo, "n.txt"), "new\n");
    await git(["add", "n.txt"]);
    await unlink(join(repo, "n.txt"));

    const { ref } = await writeRescueRef({
      worktreePath: repo,
      runId: randomUUID(),
    });

    await git(["reset", "--hard", "--quiet", "HEAD"]);

    expect(await git(["show", `${ref}:a.txt`])).toBe("working");
    expect(await git(["show", `${ref}^2:a.txt`])).toBe("staged");
    expect(await git(["show", `${ref}^2:n.txt`])).toBe("new");
  });

  it("adds no index parent when the index holds nothing the rescued tree does not", async () => {
    await writeFile(join(repo, "a.txt"), "unstaged\n");

    const unstaged = await writeRescueRef({
      worktreePath: repo,
      runId: randomUUID(),
    });

    expect(await parents(unstaged.ref)).toHaveLength(1);

    await git(["add", "a.txt"]);

    const staged = await writeRescueRef({
      worktreePath: repo,
      runId: randomUUID(),
    });

    expect(await parents(staged.ref)).toHaveLength(1);
  });

  // An unmerged index has no tree to write; its stages are history's.
  it("still rescues a tree whose index is unmerged", async () => {
    await git(["checkout", "-q", "-b", "other"]);
    await commit("a.txt", "other\n");
    await git(["checkout", "-q", "main"]);
    await commit("a.txt", "mine\n");
    await git(["merge", "-q", "other"]).catch(() => undefined);

    const { ref } = await writeRescueRef({
      worktreePath: repo,
      runId: randomUUID(),
    });

    expect(await parents(ref)).toHaveLength(1);
    expect(await git(["show", `${ref}:a.txt`])).toContain("<<<<<<<");
  });
});
