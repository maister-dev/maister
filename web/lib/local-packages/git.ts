import "server-only";

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import pino from "pino";

const execFileAsync = promisify(execFile);

const log = pino({
  name: "local-packages/git",
  level: process.env.LOG_LEVEL ?? "info",
});

const GIT_TIMEOUT_MS = 60_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;
const LOCAL_PACKAGE_RUNTIME_EXCLUDES = [".maister/", ".claude/"] as const;

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: EXEC_MAX_BUFFER,
  });
}

export async function ensureLocalPackageGitExclude(dir: string): Promise<void> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--git-path", "info/exclude"],
    {
      cwd: dir,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
    },
  );
  const rawExcludePath = stdout.trim();
  const excludePath = path.isAbsolute(rawExcludePath)
    ? rawExcludePath
    : path.join(dir, rawExcludePath);
  const current = await readFile(excludePath, "utf8").catch(() => "");
  const excluded = new Set(
    current
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  const missingExcludes = LOCAL_PACKAGE_RUNTIME_EXCLUDES.filter(
    (entry) => !excluded.has(entry) && !excluded.has(entry.replace(/\/$/, "")),
  );

  if (missingExcludes.length === 0) return;

  await mkdir(path.dirname(excludePath), { recursive: true });
  await writeFile(
    excludePath,
    `${current}${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${missingExcludes.join("\n")}\n`,
    "utf8",
  );
}

// (M39 Stream B, ADR-107) Resolve the working dir's current HEAD commit sha so a
// cut can record `package_installs.source_commit_sha` — the provenance the
// launch-time version-adopt check compares the local package's HEAD against to
// decide whether uncut Studio edits exist beyond the last cut.
export async function gitHeadSha(dir: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: EXEC_MAX_BUFFER,
  });

  return stdout.trim();
}

// (M39 Stream B, ADR-113) Point a named git remote at the publish target URL —
// idempotent: drop any prior remote of that name, then add. The URL comes from
// the registered `package_sources` allow-list (host-ambient creds, no inline
// secrets) and is passed as argv (execFile, never a shell).
export async function gitSetRemote(
  dir: string,
  name: string,
  url: string,
): Promise<void> {
  await git(dir, ["remote", "remove", name]).catch(() => undefined);
  await git(dir, ["remote", "add", name, url]);
}

// (M39 Stream B, ADR-113) Force the stable publish branch to the working dir's
// current HEAD before pushing it. `branch` is validated (branchNameSchema) by the
// caller; it is never the working dir's checked-out branch (a distinct
// `maister/<slug>`), so `-f` cannot fail on "current branch".
export async function gitSetPublishBranchToHead(
  dir: string,
  branch: string,
): Promise<void> {
  await git(dir, ["branch", "-f", branch, "HEAD"]);
}

// (M39 Stream B, ADR-113) Resolve the publish target's default branch (the PR
// base) from the remote's HEAD symref, so a PR / compare-url targets the
// upstream's real default (`master`/`develop`/…) instead of a hardcoded `main`.
// Network call, batch-mode (never prompts for credentials); best-effort — `null`
// lets the caller fall back to its default.
export async function gitRemoteDefaultBranch(
  dir: string,
  remote: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-remote", "--symref", remote, "HEAD"],
      {
        cwd: dir,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
        },
      },
    );
    const match = stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);

    return match ? match[1] : null;
  } catch {
    return null;
  }
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
  await ensureLocalPackageGitExclude(dir);
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
  await ensureLocalPackageGitExclude(dir);
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
  await ensureLocalPackageGitExclude(dir);
  await git(dir, ["checkout", "HEAD", "--", ...targets]);
  await git(dir, ["clean", "-fdq", "--", ...targets]);
}
