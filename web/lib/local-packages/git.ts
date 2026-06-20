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

// (ADR-096, D12) git-init a fresh working dir on `branch` with one commit, so a
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

// (M36 Phase 4) Commit every working-tree change (tracked edits + new files) to
// the local package branch — the editor's "Commit" action. `add -A` stages
// deletions too, so the commit captures the full working-tree state. Local
// identity only (no network), inline `-c` so a missing global git identity never
// breaks it. `--allow-empty` keeps it idempotent if there is nothing to commit.
export async function gitCommitWorkingDir(
  dir: string,
  message: string,
): Promise<void> {
  log.debug({ dir }, "git commit local-package working dir");
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

// (M36 Phase 4) Discard working-tree edits — the editor's "Discard" action. When
// `paths` is given, restore ONLY those tracked paths to HEAD (`git checkout HEAD
// -- <paths>`) AND drop any untracked file at that path (`git clean -fdq --
// <paths>`); the caller has already confined each path via
// `resolveWithinWorkingDir`. With no `paths`, restore the WHOLE tree: `git
// checkout HEAD -- .` (tracked) + `git clean -fdq` (untracked), bringing the
// working dir back to HEAD exactly. The `--` separator means every following
// token is a pathspec, so a confined path is never read as a flag.
export async function gitDiscardPaths(
  dir: string,
  paths?: readonly string[],
): Promise<void> {
  const targets = paths && paths.length > 0 ? [...paths] : ["."];

  log.debug({ dir, count: targets.length }, "git discard local-package edits");
  await git(dir, ["checkout", "HEAD", "--", ...targets]);
  await git(dir, ["clean", "-fdq", "--", ...targets]);
}
