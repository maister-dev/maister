import "server-only";

import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import pino from "pino";
import { z } from "zod";

import { MaisterError } from "@/lib/errors";
import { redactUrl } from "@/lib/repo-source";

const execFileAsync = promisify(execFile);

// Hardened env mirroring repo-source's network git: a missing credential helper
// or unknown host key fails fast (no interactive prompt) instead of blocking
// until the 60s timeout. Applied ONLY to the network push, not local git.
const NETWORK_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
};

const log = pino({
  name: "worktree",
  level: process.env.LOG_LEVEL ?? "info",
});

const GIT_TIMEOUT_MS = 60_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;
const repoPromotionLocks = new Map<string, Promise<unknown>>();

const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) => path.isAbsolute(p) && !p.split(path.sep).includes(".."),
    "must be absolute with no '..' segments",
  );

export const branchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_./-]+$/, "branch must match /^[A-Za-z0-9_./-]+$/")
  .refine((b) => !b.startsWith("-"), "branch must not start with '-'")
  .refine((b) => !b.includes(".."), "branch must not contain '..'")
  .refine((b) => !b.includes("@{"), "branch must not contain '@{'")
  .refine((b) => !b.endsWith("/"), "branch must not end with '/'")
  .refine((b) => !b.endsWith(".lock"), "branch must not end with .lock");

const gitRefSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_./-]+$/, "ref must match /^[A-Za-z0-9_./-]+$/")
  .refine((r) => !r.startsWith("-"), "ref must not start with '-'")
  .refine((r) => !r.includes(".."), "ref must not contain '..'")
  .refine((r) => !r.includes("@{"), "ref must not contain '@{'")
  .refine((r) => !r.endsWith("/"), "ref must not end with '/'")
  .refine((r) => !r.endsWith(".lock"), "ref must not end with .lock");

const mergeBaseRefSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_./-]+$/, "ref must match /^[A-Za-z0-9_./-]+$/")
  .refine((r) => !r.includes(".."), "ref must not contain '..'")
  .refine((r) => !r.includes("@{"), "ref must not contain '@{'")
  .refine((r) => !r.endsWith("/"), "ref must not end with '/'")
  .refine((r) => !r.endsWith(".lock"), "ref must not end with .lock");

const gitCommitSchema = z
  .string()
  .min(7)
  .max(64)
  .regex(/^[0-9a-fA-F]+$/, "commit must be hex");

// M22 Phase 4a (ADR-053): a repo-relative path/dir reachable by the workbench
// file reader. `ref` is server-state, but path/dir is query-controlled and
// UNTRUSTED — this rejects traversal (`..`), absolute / leading-`/`, leading-`-`
// (option injection), and NUL before git is ever shelled. Git plumbing cannot
// leave the repo object DB, so this is the outer ring of double confinement.
export const repoRelPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes("\0"), "no NUL")
  .refine((p) => !p.startsWith("/"), "must be relative")
  .refine((p) => !p.startsWith("-"), "no leading dash")
  .refine((p) => !p.split("/").includes(".."), "no .. segment");

const remoteNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_./-]+$/, "remote must match /^[A-Za-z0-9_./-]+$/")
  .refine((r) => !r.startsWith("-"), "remote must not start with '-'");

const DIFF_TRUNCATED_MARKER =
  "\n\n[maister: diff truncated — exceeded EXEC_MAX_BUFFER bound]\n";

function validate<T>(
  schema: z.ZodType<T>,
  value: unknown,
  fieldName: string,
): T {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join("; ");

    throw new MaisterError("PRECONDITION", `Invalid ${fieldName}: ${msg}`);
  }

  return parsed.data;
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

async function runGit(
  repo: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["-C", repo, ...args], {
    signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
    maxBuffer: EXEC_MAX_BUFFER,
  });
}

async function withRepoPromotionLock<T>(
  repo: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = repoPromotionLocks.get(repo) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  let next: Promise<unknown>;

  next = run
    .catch(() => undefined)
    .finally(() => {
      if (repoPromotionLocks.get(repo) === next) {
        repoPromotionLocks.delete(repo);
      }
    });

  repoPromotionLocks.set(repo, next);

  return run;
}

function errorText(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { stderr?: string };

  return (e.stderr ?? e.message ?? "").toString().trim();
}

export type AddWorktreeArgs = {
  projectRepoPath: string;
  branch: string;
  worktreePath: string;
  startPoint?: string;
};

export async function addWorktree(args: AddWorktreeArgs): Promise<void> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const wt = validate(absolutePathSchema, args.worktreePath, "worktreePath");
  const br = validate(branchNameSchema, args.branch, "branch");
  const startPoint =
    args.startPoint === undefined
      ? undefined
      : validate(gitRefSchema, args.startPoint, "startPoint");

  log.info(
    { projectRepoPath: repo, branch: br, worktreePath: wt, startPoint },
    "addWorktree",
  );

  try {
    const gitArgs = ["worktree", "add", "-b", br, "--", wt];

    if (startPoint) gitArgs.push(startPoint);

    const { stdout, stderr } = await runGit(repo, gitArgs);

    log.debug({ stdout, stderr }, "addWorktree done");
  } catch (err) {
    const stderrText = errorText(err);

    if (
      stderrText.includes("already exists") ||
      stderrText.includes("already used by worktree")
    ) {
      throw new MaisterError(
        "PRECONDITION",
        `worktree or branch already exists: ${stderrText.trim()}`,
        { cause: asError(err) },
      );
    }

    throw new MaisterError(
      "CONFLICT",
      `git worktree add failed: ${stderrText || asError(err).message}`,
      { cause: asError(err) },
    );
  }
}

export type ResolveBaseCommitArgs = {
  projectRepoPath: string;
  baseRef: string;
};

export async function resolveBaseCommit(
  args: ResolveBaseCommitArgs,
): Promise<string> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const baseRef = validate(gitRefSchema, args.baseRef, "baseRef");

  try {
    const { stdout } = await runGit(repo, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${baseRef}^{commit}`,
    ]);
    const commit = stdout.trim();

    return validate(gitCommitSchema, commit, "baseCommit").toLowerCase();
  } catch (err) {
    throw new MaisterError(
      "PRECONDITION",
      `base ref does not resolve to a commit: ${baseRef}`,
      { cause: asError(err) },
    );
  }
}

export type BranchRefArgs = {
  projectRepoPath: string;
  branch: string;
};

export async function branchExists(args: BranchRefArgs): Promise<boolean> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const branch = validate(branchNameSchema, args.branch, "branch");

  try {
    await runGit(repo, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);

    return true;
  } catch (err) {
    const exitCode = (err as { code?: unknown }).code;

    if (exitCode === 1) return false;

    throw new MaisterError(
      "CONFLICT",
      `git show-ref failed: ${errorText(err) || asError(err).message}`,
      { cause: asError(err) },
    );
  }
}

export async function removeBranch(args: BranchRefArgs): Promise<void> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const branch = validate(branchNameSchema, args.branch, "branch");

  log.info({ projectRepoPath: repo, branch }, "[FIX] removeBranch");

  try {
    const { stdout, stderr } = await runGit(repo, [
      "branch",
      "-D",
      "--",
      branch,
    ]);

    log.debug({ stdout, stderr }, "removeBranch done");
  } catch (err) {
    const stderrText = errorText(err);

    if (stderrText.includes("not found")) {
      log.debug(
        { projectRepoPath: repo, branch, stderrText },
        "removeBranch: missing — no-op",
      );

      return;
    }

    throw new MaisterError(
      "CONFLICT",
      `git branch delete failed: ${stderrText || asError(err).message}`,
      { cause: asError(err) },
    );
  }
}

export async function listBranches(projectRepoPath: string): Promise<string[]> {
  const repo = validate(absolutePathSchema, projectRepoPath, "projectRepoPath");

  try {
    const { stdout } = await runGit(repo, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ]);

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (err) {
    throw new MaisterError(
      "CONFLICT",
      `git branch list failed: ${errorText(err) || asError(err).message}`,
      { cause: asError(err) },
    );
  }
}

export type DiffRunWorkspaceArgs = {
  projectRepoPath: string;
  baseCommit: string;
  branch: string;
};

export async function diffRunWorkspace(
  args: DiffRunWorkspaceArgs,
): Promise<string> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const baseCommit = validate(gitCommitSchema, args.baseCommit, "baseCommit");
  const branch = validate(branchNameSchema, args.branch, "branch");

  try {
    const { stdout } = await runGit(repo, [
      "diff",
      "--no-ext-diff",
      `${baseCommit}...${branch}`,
    ]);

    return stdout;
  } catch (err) {
    throw new MaisterError(
      "CONFLICT",
      `git diff failed: ${errorText(err) || asError(err).message}`,
      { cause: asError(err) },
    );
  }
}

export type PromoteLocalMergeArgs = {
  projectRepoPath: string;
  sourceBranch: string;
  targetBranch: string;
};

export async function promoteLocalMerge(
  args: PromoteLocalMergeArgs,
): Promise<string> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const sourceBranch = validate(branchNameSchema, args.sourceBranch, "source");
  const targetBranch = validate(branchNameSchema, args.targetBranch, "target");

  return withRepoPromotionLock(repo, async () => {
    const previousBranch = await currentBranch(repo);

    log.info(
      { projectRepoPath: repo, sourceBranch, targetBranch },
      "[FIX] promoteLocalMerge acquired repo promotion lock",
    );

    try {
      await runGit(repo, ["switch", "--", targetBranch]);
      await runGit(repo, ["merge", "--no-ff", "--no-edit", "--", sourceBranch]);

      const { stdout } = await runGit(repo, ["rev-parse", "HEAD"]);

      return stdout.trim();
    } catch (err) {
      await abortMerge(repo);
      throw new MaisterError(
        "CONFLICT",
        `git merge failed: ${errorText(err) || asError(err).message}`,
        { cause: asError(err) },
      );
    } finally {
      if (previousBranch && previousBranch !== targetBranch) {
        try {
          await runGit(repo, ["switch", "--", previousBranch]);
        } catch (err) {
          log.warn(
            {
              projectRepoPath: repo,
              previousBranch,
              err: asError(err).message,
            },
            "failed to restore previous branch after promoteLocalMerge",
          );
        }
      }
    }
  });
}

export type PushBranchArgs = {
  projectRepoPath: string;
  remote: string;
  branch: string;
};

// Push a run branch to its remote using the host git credential helper (no
// token in argv). A push failure is transient by classification — the PR
// promotion caller maps it to EXECUTOR_UNAVAILABLE (retryable), distinct from a
// config PRECONDITION.
export async function pushBranch(args: PushBranchArgs): Promise<void> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const remote = validate(remoteNameSchema, args.remote, "remote");
  const branch = validate(branchNameSchema, args.branch, "branch");

  log.info({ projectRepoPath: repo, remote, branch }, "pushBranch");

  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["-C", repo, "push", "--end-of-options", remote, branch],
      {
        signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
        maxBuffer: EXEC_MAX_BUFFER,
        env: NETWORK_GIT_ENV,
      },
    );

    log.debug({ stdout, stderr }, "pushBranch done");
  } catch (err) {
    // git stderr embeds the resolved remote URL mid-message, which may carry
    // `https://user:token@host/…` creds (validateUrl accepts cred-bearing
    // remotes). redactUrl scrubs them before the message reaches the client/log.
    const stderrText = errorText(err) || asError(err).message;

    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `git push ${remote} ${branch} failed: ${redactUrl(stderrText)}`,
      { cause: asError(err) },
    );
  }
}

async function currentBranch(repo: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(repo, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    const branch = stdout.trim();

    return branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}

async function abortMerge(repo: string): Promise<void> {
  try {
    await runGit(repo, ["merge", "--abort"]);
  } catch {
    // No merge in progress, or abort itself failed. The original merge error
    // remains the actionable one for the caller.
  }
}

export type RemoveWorktreeArgs = {
  projectRepoPath: string;
  worktreePath: string;
  force?: boolean;
};

export async function removeWorktree(args: RemoveWorktreeArgs): Promise<void> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const wt = validate(absolutePathSchema, args.worktreePath, "worktreePath");

  const cmdArgs = ["-C", repo, "worktree", "remove"];

  if (args.force) cmdArgs.push("--force");
  cmdArgs.push(wt);

  log.info(
    { projectRepoPath: repo, worktreePath: wt, force: !!args.force },
    "removeWorktree",
  );

  try {
    const { stdout, stderr } = await execFileAsync("git", cmdArgs, {
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
      maxBuffer: EXEC_MAX_BUFFER,
    });

    log.debug({ stdout, stderr }, "removeWorktree done");
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const stderrText = (e.stderr ?? e.message ?? "").toString();

    if (
      stderrText.includes("is not a working tree") ||
      stderrText.includes("not a valid path")
    ) {
      log.debug({ stderrText }, "removeWorktree: missing — no-op");

      return;
    }

    throw new MaisterError(
      "CONFLICT",
      `git worktree remove failed: ${stderrText.trim() || e.message}`,
      { cause: asError(err) },
    );
  }
}

export type RemoveOwnedWorktreeArgs = RemoveWorktreeArgs & {
  allowedRoot: string;
};

export async function removeOwnedWorktree(
  args: RemoveOwnedWorktreeArgs,
): Promise<void> {
  const allowedRoot = validate(
    absolutePathSchema,
    args.allowedRoot,
    "allowedRoot",
  );
  const wt = validate(absolutePathSchema, args.worktreePath, "worktreePath");
  const relative = path.relative(allowedRoot, wt);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new MaisterError(
      "PRECONDITION",
      `worktreePath is outside allowed root: ${wt}`,
    );
  }

  await removeWorktree(args);
}

export type WorktreeInfo = {
  path: string;
  branch: string | null;
  head: string | null;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
};

function parsePorcelain(out: string): WorktreeInfo[] {
  const result: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const rawLine of out.split("\n")) {
    const line = rawLine.trimEnd();

    if (line === "") {
      if (current.path) {
        result.push({
          path: current.path,
          branch: current.branch ?? null,
          head: current.head ?? null,
          bare: current.bare ?? false,
          locked: current.locked ?? false,
          prunable: current.prunable ?? false,
        });
      }
      current = {};
      continue;
    }
    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.branch = null;
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = true;
    }
  }

  if (current.path) {
    result.push({
      path: current.path,
      branch: current.branch ?? null,
      head: current.head ?? null,
      bare: current.bare ?? false,
      locked: current.locked ?? false,
      prunable: current.prunable ?? false,
    });
  }

  return result;
}

export async function listWorktrees(
  projectRepoPath: string,
): Promise<WorktreeInfo[]> {
  const repo = validate(absolutePathSchema, projectRepoPath, "projectRepoPath");

  log.debug({ projectRepoPath: repo }, "listWorktrees");

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repo, "worktree", "list", "--porcelain"],
      {
        signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
        maxBuffer: EXEC_MAX_BUFFER,
      },
    );

    return parsePorcelain(stdout);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };

    throw new MaisterError(
      "CONFLICT",
      `git worktree list failed: ${(e.stderr ?? e.message).toString().trim()}`,
      { cause: asError(err) },
    );
  }
}

export type LogRangeArgs = {
  worktreePath: string;
  baseRef: string;
  branch: string;
};

export async function logRange(args: LogRangeArgs): Promise<string> {
  const wt = validate(absolutePathSchema, args.worktreePath, "worktreePath");
  const base = validate(gitRefSchema, args.baseRef, "baseRef");
  const br = validate(branchNameSchema, args.branch, "branch");

  log.debug({ worktreePath: wt, baseRef: base, branch: br }, "logRange");

  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        wt,
        "log",
        "--oneline",
        "--no-color",
        "--end-of-options",
        `${base}..${br}`,
      ],
      {
        signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
        maxBuffer: EXEC_MAX_BUFFER,
      },
    );

    const commitCount = stdout.split("\n").filter((l) => l.length > 0).length;

    log.info({ worktreePath: wt, commitCount }, "logRange done");

    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };

    throw new MaisterError(
      "CONFLICT",
      `git log ${base}..${br} failed: ${(e.stderr ?? e.message).toString().trim()}`,
      { cause: asError(err) },
    );
  }
}

export type DiffRangeArgs = {
  worktreePath: string;
  baseRef: string;
  branch: string;
};

export async function diffRange(args: DiffRangeArgs): Promise<string> {
  const wt = validate(absolutePathSchema, args.worktreePath, "worktreePath");
  const base = validate(gitRefSchema, args.baseRef, "baseRef");
  const br = validate(branchNameSchema, args.branch, "branch");

  log.debug({ worktreePath: wt, baseRef: base, branch: br }, "diffRange");

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", wt, "diff", "--no-color", "--end-of-options", `${base}..${br}`],
      {
        signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
        maxBuffer: EXEC_MAX_BUFFER,
      },
    );

    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };

    if (
      e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
      /maxBuffer length exceeded/i.test(e.message ?? "")
    ) {
      log.info(
        { worktreePath: wt, maxBuffer: EXEC_MAX_BUFFER },
        "diffRange truncated — diff exceeded EXEC_MAX_BUFFER",
      );

      return await diffRangeTruncated(wt, base, br);
    }

    throw new MaisterError(
      "CONFLICT",
      `git diff ${base}..${br} failed: ${(e.stderr ?? e.message).toString().trim()}`,
      { cause: asError(err) },
    );
  }
}

async function diffRangeTruncated(
  wt: string,
  base: string,
  br: string,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "git",
      ["-C", wt, "diff", "--no-color", "--end-of-options", `${base}..${br}`],
      { signal: AbortSignal.timeout(GIT_TIMEOUT_MS) },
    );

    let bytes = 0;
    let text = "";
    const decoder = new TextDecoder();
    let done = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (done) return;
      const remaining = EXEC_MAX_BUFFER - bytes;

      if (chunk.length >= remaining) {
        text += decoder.decode(chunk.subarray(0, remaining), { stream: true });
        text += decoder.decode();
        done = true;
        child.kill("SIGKILL");
        resolve(text + DIFF_TRUNCATED_MARKER);

        return;
      }
      text += decoder.decode(chunk, { stream: true });
      bytes += chunk.length;
    });

    child.stdout.on("end", () => {
      if (done) return;
      done = true;
      resolve(text + decoder.decode());
    });

    child.on("error", (err) => {
      if (done) return;
      done = true;
      reject(
        new MaisterError(
          "CONFLICT",
          `git diff ${base}..${br} failed: ${err.message}`,
          { cause: asError(err) },
        ),
      );
    });
  });
}

export type WorktreeStatusArgs = {
  worktreePath: string;
};

// Read-only `git status --porcelain=v1 --untracked-files=all`. Returns the raw
// porcelain output; empty string means a clean worktree (no staged, unstaged,
// or untracked changes). Mirrors logRange/diffRange validation + CONFLICT-on-
// git-failure convention. Used by the takeover return route to refuse a return
// whose uncommitted tracked edits / untracked files would otherwise be silently
// dropped from the commit-ref-only `base..branch` log/diff.
export async function statusPorcelain(
  args: WorktreeStatusArgs,
): Promise<string> {
  const wt = validate(absolutePathSchema, args.worktreePath, "worktreePath");

  log.debug({ worktreePath: wt }, "statusPorcelain");

  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        wt,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--end-of-options",
      ],
      {
        signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
        maxBuffer: EXEC_MAX_BUFFER,
      },
    );

    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };

    throw new MaisterError(
      "CONFLICT",
      `git status failed: ${(e.stderr ?? e.message).toString().trim()}`,
      { cause: asError(err) },
    );
  }
}

export type ResolveBaseRefArgs = {
  worktreePath: string;
  branch: string;
  mainBranch: string;
};

export async function resolveBaseRef(
  args: ResolveBaseRefArgs,
): Promise<string> {
  const wt = validate(absolutePathSchema, args.worktreePath, "worktreePath");
  const br = validate(mergeBaseRefSchema, args.branch, "branch");
  const main = validate(mergeBaseRefSchema, args.mainBranch, "mainBranch");

  log.debug(
    { worktreePath: wt, branch: br, mainBranch: main },
    "resolveBaseRef",
  );

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", wt, "merge-base", "--end-of-options", main, br],
      {
        signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
        maxBuffer: EXEC_MAX_BUFFER,
      },
    );

    const sha = stdout.trim();

    if (!sha) {
      throw new MaisterError(
        "CONFLICT",
        `git merge-base ${main} ${br} returned no base ref`,
      );
    }

    log.info({ worktreePath: wt, baseRef: sha }, "resolveBaseRef done");

    return sha;
  } catch (err) {
    if (err instanceof MaisterError) throw err;
    const e = err as NodeJS.ErrnoException & { stderr?: string };

    throw new MaisterError(
      "CONFLICT",
      `git merge-base ${main} ${br} failed: ${(e.stderr ?? e.message).toString().trim()}`,
      { cause: asError(err) },
    );
  }
}

// Resolve a ref (branch/tag/SHA) to its immutable 40-char commit SHA. Used at
// artifact-record time so git locators store a fixed SHA, never a mutable
// branch name (PR2/F3). Same input hardening as the sibling git helpers.
export async function resolveRefSha(
  worktreePath: string,
  ref: string,
): Promise<string> {
  const wt = validate(absolutePathSchema, worktreePath, "worktreePath");
  const r = validate(gitRefSchema, ref, "ref");

  log.debug({ worktreePath: wt, ref: r }, "resolveRefSha");

  try {
    // `rev-parse` echoes `--end-of-options`, so it cannot use the option
    // terminator the sibling helpers rely on. `--verify` + the `gitRefSchema`
    // guard (no leading `-`) is the equivalent option-injection hardening; the
    // `^{commit}` peel resolves annotated tags to their commit SHA.
    const { stdout } = await execFileAsync(
      "git",
      ["-C", wt, "rev-parse", "--verify", `${r}^{commit}`],
      {
        signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
        maxBuffer: EXEC_MAX_BUFFER,
      },
    );

    const sha = stdout.trim();

    if (!sha) {
      throw new MaisterError("CONFLICT", `git rev-parse ${r} returned no SHA`);
    }

    log.info({ worktreePath: wt, ref: r, sha }, "resolveRefSha done");

    return sha;
  } catch (err) {
    if (err instanceof MaisterError) throw err;
    const e = err as NodeJS.ErrnoException & { stderr?: string };

    throw new MaisterError(
      "CONFLICT",
      `git rev-parse ${r} failed: ${(e.stderr ?? e.message).toString().trim()}`,
      { cause: asError(err) },
    );
  }
}

export interface RepoTreeEntry {
  name: string;
  type: "file" | "dir";
}

export type ListTreeArgs = {
  repo: string;
  ref: string;
  dir: string;
};

// M22 Phase 4a (ADR-053): list one level of the git-tracked tree at `ref:dir`.
// Returns null when `dir` is not a tracked tree (`.git`, gitignored, untracked,
// or unknown) — existence-hiding, never disclosing why. `ref` is server-state;
// `dir` is validated against repoRelPathSchema before git is shelled.
export async function listTree(
  args: ListTreeArgs,
): Promise<{ path: string; entries: RepoTreeEntry[] } | null> {
  const repo = validate(absolutePathSchema, args.repo, "repo");
  const { dir } = args;
  const ref = validate(gitRefSchema, args.ref, "ref");

  if (dir !== "") validate(repoRelPathSchema, dir, "dir");

  log.debug({ repo, ref, dir }, "listTree");

  if (dir !== "") {
    try {
      const t = (
        await runGit(repo, [
          "cat-file",
          "-t",
          "--end-of-options",
          `${ref}:${dir}`,
        ])
      ).stdout.trim();

      if (t !== "tree") return null;
    } catch {
      return null;
    }
  }

  let out: string;

  try {
    out = (
      await runGit(
        repo,
        dir === ""
          ? ["ls-tree", "-z", "--end-of-options", ref]
          : ["ls-tree", "-z", "--end-of-options", ref, "--", `${dir}/`],
      )
    ).stdout;
  } catch {
    return null;
  }

  const entries: RepoTreeEntry[] = out
    .split("\0")
    .filter((line) => line.length > 0)
    .map((line): RepoTreeEntry | null => {
      const tabIdx = line.indexOf("\t");
      const meta = line.slice(0, tabIdx);
      const entryPath = line.slice(tabIdx + 1);
      const typeToken = meta.split(/\s+/)[1];

      // Skip submodule (commit) entries — a submodule is a separate repo that
      // cannot be browsed through this tree; listing it as a dir misleads.
      if (typeToken !== "blob" && typeToken !== "tree") return null;
      const type: RepoTreeEntry["type"] = typeToken === "blob" ? "file" : "dir";
      const name = entryPath.split("/").filter(Boolean).pop()!;

      return { name, type };
    })
    .filter((e): e is RepoTreeEntry => e !== null);

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;

    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return { path: dir, entries };
}

export type RepoBlobResult =
  | { kind: "text"; content: string }
  | { kind: "too-large"; size: number }
  | { kind: "binary" }
  | { kind: "not-found" };

export type ReadBlobArgs = {
  repo: string;
  ref: string;
  path: string;
  maxBytes: number;
};

// M22 Phase 4a (ADR-053): read a single git-tracked blob at `ref:path`. Anything
// not a tracked blob (`.git`, gitignored, untracked, dir, unknown) surfaces as
// not-found — uniform existence-hiding. Over-cap blobs report too-large without
// being read into memory; NUL-containing blobs are binary. `ref` is
// server-state; `path` is validated against repoRelPathSchema before git runs.
export async function readBlob(args: ReadBlobArgs): Promise<RepoBlobResult> {
  const repo = validate(absolutePathSchema, args.repo, "repo");
  const { maxBytes } = args;
  const ref = validate(gitRefSchema, args.ref, "ref");
  const blobPath = validate(repoRelPathSchema, args.path, "path");

  log.debug({ repo, ref, path: blobPath, maxBytes }, "readBlob");

  try {
    const t = (
      await runGit(repo, [
        "cat-file",
        "-t",
        "--end-of-options",
        `${ref}:${blobPath}`,
      ])
    ).stdout.trim();

    if (t !== "blob") return { kind: "not-found" };
  } catch {
    return { kind: "not-found" };
  }

  let size: number;

  try {
    size = Number(
      (
        await runGit(repo, [
          "cat-file",
          "-s",
          "--end-of-options",
          `${ref}:${blobPath}`,
        ])
      ).stdout.trim(),
    );
  } catch {
    return { kind: "not-found" };
  }

  if (size > maxBytes) return { kind: "too-large", size };

  let buf: Buffer;

  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        repo,
        "cat-file",
        "blob",
        "--end-of-options",
        `${ref}:${blobPath}`,
      ],
      {
        signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
        maxBuffer: EXEC_MAX_BUFFER,
        encoding: "buffer",
      },
    );

    buf = stdout as Buffer;
  } catch (err) {
    // A blob whose bytes exceed EXEC_MAX_BUFFER (e.g. maxBytes mis-set above the
    // buffer bound) reports too-large rather than crashing the route as a 500.
    if (
      (err as NodeJS.ErrnoException).code ===
      "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    )
      return { kind: "too-large", size };

    return { kind: "not-found" };
  }

  if (buf.includes(0)) return { kind: "binary" };

  return { kind: "text", content: buf.toString("utf8") };
}
