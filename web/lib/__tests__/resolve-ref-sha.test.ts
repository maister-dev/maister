// PR2 / F3 (RED): the runner needs a helper that resolves a ref to its
// immutable 40-char commit SHA at record time (so git artifact locators store
// a SHA, never a mutable branch name).
//
// Contract (Implementor adds to @/lib/worktree):
//   resolveRefSha(worktreePath: string, ref: string): Promise<string>
//
// RED today: the export does not exist.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveRefSha } from "@/lib/worktree";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });

  return stdout;
}

describe("resolveRefSha", () => {
  let repo: string;
  let tipSha: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "resolve-ref-sha-"));

    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "user.email", "test@maister.local");
    await git(repo, "config", "user.name", "Test");
    await git(repo, "config", "commit.gpgsign", "false");

    await writeFile(join(repo, "base.txt"), "base\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "base");

    await git(repo, "checkout", "-q", "-b", "feature");
    await writeFile(join(repo, "a.txt"), "alpha\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "add alpha");
    tipSha = (await git(repo, "rev-parse", "HEAD")).trim();
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("returns the 40-char SHA of the branch tip", async () => {
    const sha = await resolveRefSha(repo, "feature");

    expect(sha).toBe(tipSha);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});
