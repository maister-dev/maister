import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import pino from "pino";

const execFileAsync = promisify(execFile);

const log = pino({
  name: "local-packages/git",
  level: process.env.LOG_LEVEL ?? "info",
});

const GIT_TIMEOUT_MS = 60_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: EXEC_MAX_BUFFER,
  });
}

// (ADR-093, D12) git-init a fresh working dir on `branch` with one commit, so a
// local package is a real branch — the Phase-2 PR-back is then additive. Local
// identity only (no network); a missing global git identity must not break it.
export async function gitInitWithCommit(
  dir: string,
  branch: string,
  message: string,
): Promise<void> {
  log.debug({ dir, branch }, "git init local-package working dir");
  await git(dir, ["init", "-q", "-b", branch]);
  await git(dir, ["add", "-A"]);
  await git(dir, [
    "-c",
    "user.email=maister@local",
    "-c",
    "user.name=MAIster",
    "commit",
    "-q",
    "--no-verify",
    "--allow-empty",
    "-m",
    message,
  ]);
}
