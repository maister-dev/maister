import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { installWorktreeProvenance } from "@/lib/worktree-provenance";

// `git config` takes an exclusive lock on the file it writes and never retries:
// `extensions.worktreeConfig` lands in the SHARED `.git/config`, so two
// concurrent worktree allocations in one repo collide ("could not lock config
// file …: File exists") and the install surfaced a spurious CONFLICT. The
// install now retries that exact contention with a short bounded backoff
// (25/50/100/200 ms) and propagates anything else, or the same error once the
// retries are spent. Before this file the fix was covered only by a
// probabilistic two-racer case.

const execFileAsync = promisify(execFile);
const created: string[] = [];

async function gitRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "maister-config-lock-"));

  created.push(repo);
  await execFileAsync("git", ["init", "-q", repo]);

  return repo;
}

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

describe("installWorktreeProvenance under git config lock contention", () => {
  it("retries a transient config lock and installs once the lock is released", async () => {
    const repo = await gitRepo();
    const lock = path.join(repo, ".git", "config.lock");

    await writeFile(lock, "");
    setTimeout(() => {
      void rm(lock, { force: true });
    }, 30);

    await expect(
      installWorktreeProvenance({
        worktreePath: repo,
        metadata: { runId: "run-lock-1" },
      }),
    ).resolves.toBeUndefined();

    const { stdout } = await execFileAsync("git", [
      "-C",
      repo,
      "config",
      "--get",
      "extensions.worktreeConfig",
    ]);

    expect(stdout.trim()).toBe("true");
  }, 20_000);

  it("gives up after the bounded backoff and surfaces the original lock error", async () => {
    const repo = await gitRepo();

    await writeFile(path.join(repo, ".git", "config.lock"), "");

    const started = Date.now();

    await expect(
      installWorktreeProvenance({
        worktreePath: repo,
        metadata: { runId: "run-lock-2" },
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("could not lock config file"),
    });

    // 25 + 50 + 100 + 200 ms of backoff before the fifth attempt fails for good.
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  }, 20_000);
});
