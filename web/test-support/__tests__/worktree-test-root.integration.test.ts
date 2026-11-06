import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createInvocation,
  fixtureProcessEnvironment,
  registerRoot,
  removeInvocationRoots,
} from "../process-invocation";
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

  it("retires linked worktrees before removing their registered parent repository", async () => {
    const repository = await mkdtemp(
      path.join(os.tmpdir(), "maister-root-order-repo-"),
    );
    const evidence = await mkdtemp(
      path.join(os.tmpdir(), "maister-root-order-evidence-"),
    );
    const invocation = await createInvocation(evidence);
    const worktreesRoot = createTestWorktreesRoot("vitest", randomUUID());
    const worktreePath = path.join(worktreesRoot, "project", "run");

    temporaryRepositories.push(repository, evidence, worktreesRoot);
    await git(repository, "init");
    await git(repository, "config", "user.email", "test@example.invalid");
    await git(repository, "config", "user.name", "MAIster Test");
    await writeFile(path.join(repository, "README.md"), "test\n");
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
    await registerRoot(invocation, repository, "fixture");
    let registryAfterCleanup: string | null = null;

    await removeInvocationRoots(invocation, async () => {
      await cleanupTestWorktrees(worktreesRoot);
      registryAfterCleanup = await git(
        repository,
        "worktree",
        "list",
        "--porcelain",
      );
    });

    expect(registryAfterCleanup).not.toBeNull();
    expect(registryAfterCleanup).not.toContain(worktreePath);
    await expect(access(repository)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(worktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a live owned process before root preparation and rechecks after it", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "maister-root-quiescence-"),
    );
    const evidence = await mkdtemp(
      path.join(os.tmpdir(), "maister-root-quiescence-evidence-"),
    );
    const invocation = await createInvocation(evidence);
    const environment = await fixtureProcessEnvironment(invocation);
    let child: ChildProcess | null = null;

    temporaryRepositories.push(root, evidence);
    await registerRoot(invocation, root, "fixture");
    try {
      await expect(
        removeInvocationRoots(invocation, async () => {
          child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
            env: { ...process.env, ...environment },
            stdio: ["pipe", "ignore", "ignore"],
          });
          await new Promise<void>((resolve, reject) => {
            child!.once("spawn", resolve);
            child!.once("error", reject);
          });
        }),
      ).rejects.toThrow(
        "cannot remove roots while invocation processes remain alive",
      );
      await expect(access(root)).resolves.toBeUndefined();
      let preparedWhileLive = false;

      await expect(
        removeInvocationRoots(invocation, async () => {
          preparedWhileLive = true;
        }),
      ).rejects.toThrow(
        "cannot remove roots while invocation processes remain alive",
      );
      expect(preparedWhileLive).toBe(false);
    } finally {
      const owned = child as ChildProcess | null;

      if (owned && owned.exitCode === null && owned.signalCode === null) {
        const exited = new Promise<void>((resolve) =>
          owned.once("exit", () => resolve()),
        );

        owned.kill("SIGTERM");
        await exited;
      }
    }
    await removeInvocationRoots(invocation);
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
