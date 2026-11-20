import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { buildAutoPromotionReaders } from "@/lib/auto-promotion/readers";

it("reads dependency blobs from the selected worktree despite inherited Git routing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "maister-promotion-git-"));
  const path = "package.json";
  const base = '{"dependencies":{"example":"1.0.0"}}\n';
  const branch = '{"dependencies":{"example":"2.0.0"}}\n';
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  try {
    git("init", "--quiet");
    git("config", "user.name", "MAIster test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    await writeFile(join(cwd, path), base);
    git("add", "--", path);
    git("commit", "--quiet", "-m", "base");
    const baseRef = git("rev-parse", "HEAD");
    await writeFile(join(cwd, path), branch);
    git("add", "--", path);
    git("commit", "--quiet", "-m", "branch");
    const branchRef = git("rev-parse", "HEAD");

    vi.stubEnv("GIT_DIR", join(cwd, "missing-git-directory"));
    const readers = buildAutoPromotionReaders({
      db: undefined,
      branch: branchRef,
      baseRef,
      runId: "promotion-git-read",
      worktreePath: cwd,
    });

    await expect(
      readers.readDepsFiles([
        { path, status: "M", additions: 1, deletions: 1, binary: false },
      ]),
    ).resolves.toEqual([{ path, status: "M", base, branch }]);
  } finally {
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  }
});
