import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTestWorktrees,
  createTestWorktreesRoot,
  resolveTestWorktreesRoot,
} from "../worktree-test-root";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...arguments_], {
    maxBuffer: 1024 * 1024,
  });

  return stdout;
}

afterEach(async () => {
  for (const repository of temporaryRepositories.splice(0)) {
    await rm(repository, { force: true, recursive: true });
  }
});

describe("test worktree roots", () => {
  it("rejects an operator root instead of inheriting it into an E2E invocation", () => {
    expect(() =>
      resolveTestWorktreesRoot("e2e", {
        MAISTER_WORKTREES_ROOT: "/operator/.maister/worktrees",
        NODE_ENV: "test",
      }),
    ).toThrow("managed test root");
  });

  it("removes a linked Git worktree through its owning repository before deleting the test root", async () => {
    const repository = await mkdtemp(
      path.join(os.tmpdir(), "maister-test-repo-"),
    );
    const worktreesRoot = createTestWorktreesRoot("vitest", randomUUID());
    const worktreePath = path.join(worktreesRoot, "project", "run");

    temporaryRepositories.push(repository);

    await git(repository, "init");
    await git(repository, "config", "user.email", "test@example.invalid");
    await git(repository, "config", "user.name", "MAIster Test");
    await writeFile(path.join(repository, "README.md"), "test\n", "utf8");
    await git(repository, "add", "README.md");
    await git(repository, "commit", "-m", "initial");
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await git(
      repository,
      "worktree",
      "add",
      "-b",
      "test-worktree",
      worktreePath,
    );

    await cleanupTestWorktrees(worktreesRoot);

    await expect(access(worktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(worktreesRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      git(repository, "worktree", "list", "--porcelain"),
    ).resolves.not.toContain(worktreePath);
  });
});
