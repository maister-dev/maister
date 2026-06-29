import "server-only";

import { execFile, spawn } from "node:child_process";
import {
  copyFile as fsCopyFile,
  mkdtemp as fsMkdtemp,
  rm as fsRm,
} from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import pino from "pino";
import { z } from "zod";

import { MaisterError } from "@/lib/errors";
import { containmentAssert } from "@/lib/flows/graph/workspace-checkpoint";
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

export const remoteNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_./-]+$/, "remote must match /^[A-Za-z0-9_./-]+$/")
  .refine((r) => !r.startsWith("-"), "remote must not start with '-'");

export const DIFF_TRUNCATED_MARKER =
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

export type AddDetachedWorktreeArgs = {
  projectRepoPath: string;
  worktreePath: string;
  committish: string;
};

// ADR-090 rework (workspace_ref): an EPHEMERAL read-only checkout at a
// resolved ref — detached HEAD, no branch created, never switching the
// user's checkout. Removed at the run's terminal choke point.
export async function addDetachedWorktree(
  args: AddDetachedWorktreeArgs,
): Promise<void> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const wt = validate(absolutePathSchema, args.worktreePath, "worktreePath");
  const committish = validate(gitRefSchema, args.committish, "committish");

  log.info(
    { projectRepoPath: repo, worktreePath: wt, committish },
    "addDetachedWorktree",
  );

  try {
    const { stdout, stderr } = await runGit(repo, [
      "worktree",
      "add",
      "--detach",
      "--",
      wt,
      committish,
    ]);

    log.debug({ stdout, stderr }, "addDetachedWorktree done");
  } catch (err) {
    const stderrText = errorText(err);

    if (
      stderrText.includes("already exists") ||
      stderrText.includes("already used by worktree")
    ) {
      throw new MaisterError(
        "PRECONDITION",
        `worktree path already exists: ${stderrText.trim()}`,
        { cause: asError(err) },
      );
    }

    throw new MaisterError(
      "CONFLICT",
      `git worktree add --detach failed: ${stderrText || asError(err).message}`,
      { cause: asError(err) },
    );
  }
}

export type ResolveBaseCommitArgs = {
  projectRepoPath: string;
  baseRef: string;
  // Prefer the remote-tracking commit (`<preferRemote>/<baseRef>`) when it
  // resolves, so a launch forks from the freshest fetched origin state instead
  // of a stale local branch; falls back to `<baseRef>`. Only meaningful right
  // after a fetch. Omitted by callers that want the local ref verbatim.
  preferRemote?: string;
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

  const candidates =
    args.preferRemote === undefined
      ? [baseRef]
      : [`${args.preferRemote}/${baseRef}`, baseRef];
  let lastErr: unknown;

  for (const ref of candidates) {
    try {
      const { stdout } = await runGit(repo, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ]);

      return validate(
        gitCommitSchema,
        stdout.trim(),
        "baseCommit",
      ).toLowerCase();
    } catch (err) {
      lastErr = err;
    }
  }

  throw new MaisterError(
    "PRECONDITION",
    `base ref does not resolve to a commit: ${baseRef}`,
    { cause: asError(lastErr) },
  );
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

  log.info({ projectRepoPath: repo, branch }, "removeBranch");

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

export async function listBranches(
  projectRepoPath: string,
  opts?: { includeRemotes?: boolean },
): Promise<string[]> {
  const repo = validate(absolutePathSchema, projectRepoPath, "projectRepoPath");

  try {
    const { stdout } = await runGit(repo, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads",
      ...(opts?.includeRemotes ? ["refs/remotes/origin"] : []),
    ]);

    // Collapse local `refs/heads/<name>` and remote `refs/remotes/origin/<name>`
    // onto the bare branch name so a branch appears once whether it is local,
    // remote, or both; skip the `origin/HEAD` symbolic default. Full refnames
    // are used (not `refname:short`, which renders origin/HEAD as the ambiguous
    // bare `origin`). Insertion order keeps local heads first.
    const names: string[] = [];
    const seen = new Set<string>();

    for (const line of stdout.split("\n")) {
      const ref = line.trim();
      let name: string | null = null;

      if (ref.startsWith("refs/heads/")) {
        name = ref.slice("refs/heads/".length);
      } else if (ref.startsWith("refs/remotes/origin/")) {
        const remoteName = ref.slice("refs/remotes/origin/".length);

        if (remoteName !== "HEAD") name = remoteName;
      }

      if (name !== null && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }

    return names;
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
): Promise<DiffResult> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const baseCommit = validate(gitCommitSchema, args.baseCommit, "baseCommit");
  const branch = validate(branchNameSchema, args.branch, "branch");
  const diffArgs = ["diff", "--no-ext-diff", `${baseCommit}..${branch}`];

  try {
    // 2-dot: the literal stored-base -> branch tree delta. A 3-dot range diffs
    // from merge-base(base, branch), which under-reports the branch when its
    // history is rewritten off its stored base (rebase/reset). Matches the
    // documented contract (workbench.md) and the M18 review-panel `diffRange`.
    const { stdout } = await runGit(repo, diffArgs);

    return { text: stdout, truncated: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;

    // An oversized diff degrades to a bounded prefix with a structured
    // `truncated` flag instead of throwing, so the workbench/review surface can
    // block on it rather than 500 (parity with `diffRange`).
    if (
      e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
      /maxBuffer length exceeded/i.test(e.message ?? "")
    ) {
      log.info(
        { projectRepoPath: repo, maxBuffer: EXEC_MAX_BUFFER },
        "diffRunWorkspace truncated — diff exceeded EXEC_MAX_BUFFER",
      );

      const text = await streamGitDiffTruncated(repo, diffArgs);

      return { text, truncated: true };
    }

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
      "promoteLocalMerge acquired repo promotion lock",
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

export async function promoteRebaseMerge(
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
      "promoteRebaseMerge acquired repo promotion lock",
    );

    try {
      await runGit(repo, ["switch", "--", sourceBranch]);
      await runGit(repo, ["rebase", "--", targetBranch]);
      await runGit(repo, ["switch", "--", targetBranch]);
      await runGit(repo, ["merge", "--ff-only", "--", sourceBranch]);

      const { stdout } = await runGit(repo, ["rev-parse", "HEAD"]);

      return stdout.trim();
    } catch (err) {
      await abortRebase(repo);
      throw new MaisterError(
        "CONFLICT",
        `git rebase/merge failed: ${errorText(err) || asError(err).message}`,
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
            "failed to restore previous branch after promoteRebaseMerge",
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
  force?: boolean;
  // ADR-093: `git push -u` — sets the branch's upstream to remote/branch while
  // pushing (the "set upstream" remotes action).
  setUpstream?: boolean;
};

export type PushRejectedReason = "non_fast_forward";

export class GitPushRejectedError extends MaisterError {
  readonly pushRejected: PushRejectedReason;
  readonly canForce: boolean;
  readonly retryHint: string;

  constructor(
    message: string,
    options?: ErrorOptions & {
      pushRejected?: PushRejectedReason;
      canForce?: boolean;
      retryHint?: string;
    },
  ) {
    super("CONFLICT", message, options);
    this.name = "GitPushRejectedError";
    this.pushRejected = options?.pushRejected ?? "non_fast_forward";
    this.canForce = options?.canForce ?? true;
    this.retryHint =
      options?.retryHint ??
      "Remote branch has newer commits. Review the remote branch or retry with force-with-lease.";
    Object.setPrototypeOf(this, GitPushRejectedError.prototype);
  }
}

function isNonFastForwardPush(stderrText: string): boolean {
  const lower = stderrText.toLowerCase();

  return (
    lower.includes("non-fast-forward") ||
    lower.includes("fetch first") ||
    lower.includes("stale info") ||
    (lower.includes("[rejected]") && lower.includes("failed to push"))
  );
}

// Push a run branch to its remote using the host git credential helper (no
// token in argv). A non-fast-forward rejection is an operator conflict; other
// failures remain transient by classification.
export async function pushBranch(args: PushBranchArgs): Promise<void> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const remote = validate(remoteNameSchema, args.remote, "remote");
  const branch = validate(branchNameSchema, args.branch, "branch");
  const force = args.force === true;

  log.info({ projectRepoPath: repo, remote, branch, force }, "pushBranch");

  try {
    const pushArgs = [
      "-C",
      repo,
      "push",
      ...(force ? ["--force-with-lease"] : []),
      ...(args.setUpstream === true ? ["--set-upstream"] : []),
      "--end-of-options",
      remote,
      branch,
    ];
    const { stdout, stderr } = await execFileAsync("git", pushArgs, {
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
      maxBuffer: EXEC_MAX_BUFFER,
      env: NETWORK_GIT_ENV,
    });

    log.debug({ stdout, stderr }, "pushBranch done");
  } catch (err) {
    // git stderr embeds the resolved remote URL mid-message, which may carry
    // `https://user:token@host/…` creds (validateUrl accepts cred-bearing
    // remotes). redactUrl scrubs them before the message reaches the client/log.
    const stderrText = errorText(err) || asError(err).message;
    const redacted = redactUrl(stderrText);

    if (!force && isNonFastForwardPush(stderrText)) {
      throw new GitPushRejectedError(
        `git push ${remote} ${branch} rejected: ${redacted}`,
        { cause: asError(err) },
      );
    }

    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `git push ${remote} ${branch} failed: ${redacted}`,
      { cause: asError(err) },
    );
  }
}

export type ListRemotesArgs = {
  projectRepoPath: string;
};

export async function listRemotes(args: ListRemotesArgs): Promise<string[]> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );

  log.debug({ projectRepoPath: repo }, "listRemotes");

  try {
    const { stdout } = await runGit(repo, ["remote"]);

    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((remote) => validate(remoteNameSchema, remote, "remote"));
  } catch (err) {
    throw new MaisterError(
      "CONFLICT",
      `git remote failed: ${errorText(err) || asError(err).message}`,
      { cause: asError(err) },
    );
  }
}

// ADR-093 Workstream 6: git remote management primitives. `name` is validated
// against the SHARED remoteNameSchema (dotted/slashed allowed, no leading '-')
// — the same schema listRemotes/pushBranch validate, so a slashed remote added
// here never throws in those readers. `url` is scheme-validated by the caller
// (git-remotes.validateUrl) before reaching here; neither arg can be read as an
// option (name has no leading '-', url carries a scheme). Path-confined to the
// project repo (server-state). All git stderr is redacted (URLs carry creds).
export type RemoteMutateArgs = {
  projectRepoPath: string;
  name: string;
  url: string;
};

export async function remoteAdd(args: RemoteMutateArgs): Promise<void> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const name = validate(remoteNameSchema, args.name, "remote");

  log.info({ projectRepoPath: repo, remote: name }, "remoteAdd");

  try {
    await runGit(repo, ["remote", "add", name, args.url]);
  } catch (err) {
    const stderrText = errorText(err);

    if (stderrText.includes("already exists")) {
      throw new MaisterError("CONFLICT", `remote already exists: ${name}`, {
        cause: asError(err),
      });
    }

    throw new MaisterError(
      "CONFLICT",
      `git remote add failed: ${redactUrl(stderrText || asError(err).message)}`,
      { cause: asError(err) },
    );
  }
}

export async function remoteSetUrl(args: RemoteMutateArgs): Promise<void> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const name = validate(remoteNameSchema, args.name, "remote");

  log.info({ projectRepoPath: repo, remote: name }, "remoteSetUrl");

  try {
    await runGit(repo, ["remote", "set-url", name, args.url]);
  } catch (err) {
    const stderrText = errorText(err);

    if (stderrText.includes("No such remote")) {
      throw new MaisterError("PRECONDITION", `remote not found: ${name}`, {
        cause: asError(err),
      });
    }

    throw new MaisterError(
      "CONFLICT",
      `git remote set-url failed: ${redactUrl(stderrText || asError(err).message)}`,
      { cause: asError(err) },
    );
  }
}

export type RemoteNameArgs = {
  projectRepoPath: string;
  name: string;
};

export async function remoteRemove(args: RemoteNameArgs): Promise<void> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const name = validate(remoteNameSchema, args.name, "remote");

  log.info({ projectRepoPath: repo, remote: name }, "remoteRemove");

  try {
    await runGit(repo, ["remote", "remove", name]);
  } catch (err) {
    const stderrText = errorText(err);

    if (stderrText.includes("No such remote")) {
      log.debug(
        { projectRepoPath: repo, remote: name },
        "remoteRemove: missing — no-op",
      );

      return;
    }

    throw new MaisterError(
      "CONFLICT",
      `git remote remove failed: ${stderrText || asError(err).message}`,
      { cause: asError(err) },
    );
  }
}

export type RemoteUrlEntry = { name: string; url: string };

// `git remote -v` collapsed to one row per remote (the fetch URL). URLs are
// returned RAW (may carry creds) — the orchestrator redacts before display.
export async function listRemoteUrls(
  projectRepoPath: string,
): Promise<RemoteUrlEntry[]> {
  const repo = validate(absolutePathSchema, projectRepoPath, "projectRepoPath");

  log.debug({ projectRepoPath: repo }, "listRemoteUrls");

  try {
    const { stdout } = await runGit(repo, ["remote", "-v"]);
    const byName = new Map<string, string>();

    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);

      if (!match) continue;
      const [, name, url, kind] = match;

      if (kind === "fetch" || !byName.has(name)) byName.set(name, url);
    }

    return [...byName.entries()].map(([name, url]) => ({ name, url }));
  } catch (err) {
    throw new MaisterError(
      "CONFLICT",
      `git remote -v failed: ${errorText(err) || asError(err).message}`,
      { cause: asError(err) },
    );
  }
}

// Single remote's URL (`git remote get-url`), RAW. null when the remote is
// absent — used by the origin DB-cache self-heal (reconcile).
export async function getRemoteUrl(
  args: RemoteNameArgs,
): Promise<string | null> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const name = validate(remoteNameSchema, args.name, "remote");

  try {
    const { stdout } = await runGit(repo, ["remote", "get-url", name]);
    const url = stdout.trim();

    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

// `git fetch <remote>` — a NETWORK op via host-ambient auth (NETWORK_GIT_ENV,
// no token in argv). A failure is EXECUTOR_UNAVAILABLE (redacted); the
// orchestrator surfaces it as an advisory, nothing to roll back.
export async function fetchRemote(args: RemoteNameArgs): Promise<void> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const name = validate(remoteNameSchema, args.name, "remote");

  log.info({ projectRepoPath: repo, remote: name }, "fetchRemote");

  try {
    await execFileAsync(
      "git",
      ["-C", repo, "fetch", "--end-of-options", name],
      {
        signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
        maxBuffer: EXEC_MAX_BUFFER,
        env: NETWORK_GIT_ENV,
      },
    );
  } catch (err) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `git fetch ${name} failed: ${redactUrl(errorText(err) || asError(err).message)}`,
      { cause: asError(err) },
    );
  }
}

// Resolve a repo's default branch for DB-default registration (ADR-093): the
// remote's HEAD when a clone has one, else the current local branch, else the
// "main" literal. Best-effort and never-throw, mirroring readRemoteOrigin.
export async function getDefaultBranch(
  projectRepoPath: string,
): Promise<string> {
  const repo = validate(absolutePathSchema, projectRepoPath, "projectRepoPath");

  log.debug({ projectRepoPath: repo }, "getDefaultBranch");

  try {
    const { stdout } = await runGit(repo, [
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const ref = stdout.trim();

    if (ref) {
      const branch = ref.replace(/^origin\//, "");

      log.debug({ branch, tier: "origin-head" }, "getDefaultBranch resolved");

      return branch;
    }
  } catch {
    // no refs/remotes/origin/HEAD — fall through to the local HEAD
  }

  try {
    const { stdout } = await runGit(repo, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    const branch = stdout.trim();

    if (branch && branch !== "HEAD") {
      log.debug({ branch, tier: "head" }, "getDefaultBranch resolved");

      return branch;
    }
  } catch {
    // not a git repo / detached HEAD — fall through to the default
  }

  log.debug({ branch: "main", tier: "fallback" }, "getDefaultBranch resolved");

  return "main";
}

// ADR-093 (persist-config): is this path a git work tree at all? Distinct from
// getDefaultBranch (never-throw) so the persist precondition can give a clear
// "not a git repo" message before the branch/clean-tree checks.
export async function isGitRepo(projectRepoPath: string): Promise<boolean> {
  const repo = validate(absolutePathSchema, projectRepoPath, "projectRepoPath");

  try {
    await runGit(repo, ["rev-parse", "--git-dir"]);

    return true;
  } catch {
    return false;
  }
}

// ADR-093 (persist-config): the current branch via `symbolic-ref` — which,
// unlike `rev-parse --abbrev-ref`, resolves on an UNBORN HEAD (a fresh
// `git init` repo points at its default branch with no commits yet), so the
// new-empty onboarding case passes the "HEAD on main_branch" precondition.
// null = detached HEAD or not a git repo.
export async function currentBranchName(
  projectRepoPath: string,
): Promise<string | null> {
  const repo = validate(absolutePathSchema, projectRepoPath, "projectRepoPath");

  try {
    const { stdout } = await runGit(repo, ["symbolic-ref", "--short", "HEAD"]);
    const branch = stdout.trim();

    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

// ADR-093 (persist-config idempotent reconcile): a tracked file's content at
// HEAD. null when HEAD is unborn or the file is not committed. Used to detect a
// prior persist that committed maister.yaml but crashed before the DB flip.
export async function showFileAtHead(
  projectRepoPath: string,
  file: string,
): Promise<string | null> {
  const repo = validate(absolutePathSchema, projectRepoPath, "projectRepoPath");
  const f = validate(repoRelPathSchema, file, "file");

  try {
    const { stdout } = await runGit(repo, ["show", `HEAD:${f}`]);

    return stdout;
  } catch {
    return null;
  }
}

// Read a single git config value (any scope). null when unset (exit 1) so the
// caller can default rather than let `git commit` fail.
async function gitConfigValue(
  repo: string,
  key: "user.name" | "user.email",
): Promise<string | null> {
  try {
    const { stdout } = await runGit(repo, ["config", "--get", key]);
    const value = stdout.trim();

    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

// ADR-093: per-field `-c user.*` default args for `git commit` when the host git
// author is unset — a configured host name/email is never overridden, only the
// missing field is defaulted. Without this a `git commit` on a host (or CI
// runner) with no global identity fails with "empty ident name not allowed".
// Shared by commitFile, snapshotDirtyWorktree, and squashRunBranch.
async function commitIdentityArgs(repo: string): Promise<string[]> {
  const [name, email] = await Promise.all([
    gitConfigValue(repo, "user.name"),
    gitConfigValue(repo, "user.email"),
  ]);
  const identityArgs: string[] = [];

  if (!name) identityArgs.push("-c", "user.name=maister");
  if (!email) identityArgs.push("-c", "user.email=noreply@maister.local");

  return identityArgs;
}

export type CommitFileArgs = {
  repo: string;
  file: string;
  message: string;
};

export type CommitFileResult = {
  usedDefaultAuthor: boolean;
};

// ADR-093 (persist-config): stage one repo-relative file and commit it. When the
// host git author is UNSET, supply a default identity PER-FIELD via `-c` (a
// configured host name/email is never overridden — only the missing one is
// defaulted) and report `usedDefaultAuthor` so the UI can nudge the operator.
// Works on an unborn HEAD (the first commit of a fresh `git init` repo). NOT a
// network op — push is the caller's opt-in step.
export async function commitFile(
  args: CommitFileArgs,
): Promise<CommitFileResult> {
  const repo = validate(absolutePathSchema, args.repo, "repo");
  const file = validate(repoRelPathSchema, args.file, "file");
  const message = validate(commitMessageSchema, args.message, "commitMessage");

  log.info({ repo, file }, "commitFile");

  try {
    await runGit(repo, ["add", "--", file]);

    const identityArgs = await commitIdentityArgs(repo);
    const usedDefaultAuthor = identityArgs.length > 0;

    const { stdout, stderr } = await runGit(repo, [
      ...identityArgs,
      "commit",
      "-m",
      message,
    ]);

    log.info({ repo, file, usedDefaultAuthor }, "commitFile done");
    log.debug({ stdout, stderr }, "commitFile git output");

    return { usedDefaultAuthor };
  } catch (err) {
    throw new MaisterError(
      "PRECONDITION",
      `git commit failed: ${errorText(err) || asError(err).message}`,
      { cause: asError(err) },
    );
  }
}

export type HeadCommitArgs = {
  worktreePath: string;
};

export async function headCommit(args: HeadCommitArgs): Promise<string> {
  const wt = validate(absolutePathSchema, args.worktreePath, "worktreePath");

  log.debug({ worktreePath: wt }, "headCommit");

  try {
    const { stdout } = await runGit(wt, ["rev-parse", "HEAD"]);

    return validate(gitCommitSchema, stdout.trim(), "commit");
  } catch (err) {
    throw new MaisterError(
      "CONFLICT",
      `git rev-parse HEAD failed: ${errorText(err) || asError(err).message}`,
      { cause: asError(err) },
    );
  }
}

function isGitMissingRef(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException & { code?: number };

  return e.code === 1 || e.code === 2;
}

export type LocalBranchExistsArgs = {
  projectRepoPath: string;
  branch: string;
};

export async function localBranchExists(
  args: LocalBranchExistsArgs,
): Promise<boolean> {
  return (await localBranchHead(args)) !== null;
}

export type LocalBranchHeadArgs = {
  projectRepoPath: string;
  branch: string;
};

export async function localBranchHead(
  args: LocalBranchHeadArgs,
): Promise<string | null> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const branch = validate(branchNameSchema, args.branch, "branch");

  log.debug({ projectRepoPath: repo, branch }, "localBranchHead");

  try {
    const { stdout } = await runGit(repo, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}^{commit}`,
    ]);

    return validate(gitCommitSchema, stdout.trim(), "commit");
  } catch (err) {
    if (isGitMissingRef(err)) return null;

    throw new MaisterError(
      "CONFLICT",
      `git rev-parse ${branch} failed: ${errorText(err) || asError(err).message}`,
      { cause: asError(err) },
    );
  }
}

export type RemoteBranchExistsArgs = {
  projectRepoPath: string;
  remote: string;
  branch: string;
};

export async function remoteBranchExists(
  args: RemoteBranchExistsArgs,
): Promise<boolean> {
  return (await remoteBranchHead(args)) !== null;
}

export type RemoteBranchHeadArgs = {
  projectRepoPath: string;
  remote: string;
  branch: string;
};

export async function remoteBranchHead(
  args: RemoteBranchHeadArgs,
): Promise<string | null> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const remote = validate(remoteNameSchema, args.remote, "remote");
  const branch = validate(branchNameSchema, args.branch, "branch");

  log.debug({ projectRepoPath: repo, remote, branch }, "remoteBranchHead");

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repo, "ls-remote", "--exit-code", "--heads", remote, branch],
      {
        signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
        maxBuffer: EXEC_MAX_BUFFER,
        env: NETWORK_GIT_ENV,
      },
    );
    const [commit] = stdout.trim().split(/\s+/, 1);

    return validate(gitCommitSchema, commit, "commit");
  } catch (err) {
    if (isGitMissingRef(err)) return null;

    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `git ls-remote ${remote} ${branch} failed: ${redactUrl(errorText(err) || asError(err).message)}`,
      { cause: asError(err) },
    );
  }
}

export type CreateBranchAtHeadArgs = {
  worktreePath: string;
  branch: string;
};

export async function createBranchAtHead(
  args: CreateBranchAtHeadArgs,
): Promise<void> {
  const wt = validate(absolutePathSchema, args.worktreePath, "worktreePath");
  const branch = validate(branchNameSchema, args.branch, "branch");

  log.info({ worktreePath: wt, branch }, "createBranchAtHead");

  try {
    const { stdout, stderr } = await runGit(wt, [
      "branch",
      "--",
      branch,
      "HEAD",
    ]);

    log.debug({ stdout, stderr }, "createBranchAtHead done");
  } catch (err) {
    const stderrText = errorText(err);

    if (stderrText.includes("already exists")) {
      throw new MaisterError(
        "CONFLICT",
        `local branch already exists: ${branch}`,
        { cause: asError(err) },
      );
    }

    throw new MaisterError(
      "CONFLICT",
      `git branch ${branch} failed: ${stderrText || asError(err).message}`,
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

async function abortRebase(repo: string): Promise<void> {
  try {
    await runGit(repo, ["rebase", "--abort"]);
  } catch {
    // No rebase in progress, or abort itself failed. The original rebase error
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

// A diff plus whether it was cut at EXEC_MAX_BUFFER. `truncated` is the
// structured signal a partial diff carries instead of an in-band marker, so a
// promotion/review surface can block on it rather than silently render a prefix.
export type DiffResult = { text: string; truncated: boolean };

export async function diffRange(args: DiffRangeArgs): Promise<DiffResult> {
  const wt = validate(absolutePathSchema, args.worktreePath, "worktreePath");
  const base = validate(gitRefSchema, args.baseRef, "baseRef");
  const br = validate(branchNameSchema, args.branch, "branch");
  const diffArgs = ["diff", "--no-color", "--end-of-options", `${base}..${br}`];

  log.debug({ worktreePath: wt, baseRef: base, branch: br }, "diffRange");

  try {
    const { stdout } = await execFileAsync("git", ["-C", wt, ...diffArgs], {
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
      maxBuffer: EXEC_MAX_BUFFER,
    });

    return { text: stdout, truncated: false };
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

      const text = await streamGitDiffTruncated(wt, diffArgs);

      return { text, truncated: true };
    }

    throw new MaisterError(
      "CONFLICT",
      `git diff ${base}..${br} failed: ${(e.stderr ?? e.message).toString().trim()}`,
      { cause: asError(err) },
    );
  }
}

// Stream `git -C <repo> <diffArgs>` and stop at EXEC_MAX_BUFFER bytes, returning
// the partial diff WITHOUT a marker (the caller's `truncated` flag carries that
// signal). The diff readers' maxBuffer fallback, so an oversized diff degrades
// to a bounded prefix instead of throwing.
async function streamGitDiffTruncated(
  repo: string,
  diffArgs: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("git", ["-C", repo, ...diffArgs], {
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
      env: env ?? process.env,
    });

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
        resolve(text);

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
        new MaisterError("CONFLICT", `git diff failed: ${err.message}`, {
          cause: asError(err),
        }),
      );
    });
  });
}

// M30 (ADR-082, `uncommitted` diff scope): HEAD vs working tree, with
// untracked files rendered as additions, WITHOUT ever mutating the real
// index. Mechanism: copy the worktree's real index file to a temp
// GIT_INDEX_FILE, run `git add -N .` (intent-to-add for untracked; respects
// .gitignore) against the COPY, then `git diff HEAD` under the copy. A bare
// `git add -N` against the real index would flip untracked files to
// intent-to-add and corrupt `git status` for every other consumer.
export type WorkingTreeDiffResult = DiffResult & {
  nameStatus: Array<{ path: string; status: string }>;
};

async function withIntentToAddTempIndex<T>(
  worktreePath: string,
  fn: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const tmpDir = await fsMkdtemp(path.join(osTmpdir(), "maister-wtdiff-"));
  const tmpIndex = path.join(tmpDir, "index");

  try {
    const { stdout: indexPathRaw } = await execFileAsync(
      "git",
      ["-C", worktreePath, "rev-parse", "--git-path", "index"],
      {
        signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
        maxBuffer: EXEC_MAX_BUFFER,
      },
    );
    const realIndex = path.isAbsolute(indexPathRaw.trim())
      ? indexPathRaw.trim()
      : path.join(worktreePath, indexPathRaw.trim());

    try {
      await fsCopyFile(realIndex, tmpIndex);
    } catch {
      // A repo with no index yet (fresh) — the temp index starts empty.
    }

    const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };

    await execFileAsync("git", ["-C", worktreePath, "add", "-N", "."], {
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
      maxBuffer: EXEC_MAX_BUFFER,
      env,
    });

    return await fn(env);
  } finally {
    await fsRm(tmpDir, { recursive: true, force: true });
  }
}

export async function diffWorkingTree(
  worktreePath: string,
  baseRef: string = "HEAD",
): Promise<WorkingTreeDiffResult> {
  const wt = validate(absolutePathSchema, worktreePath, "worktreePath");
  const base =
    baseRef === "HEAD" ? "HEAD" : validate(gitRefSchema, baseRef, "baseRef");

  return await withIntentToAddTempIndex(wt, async (env) => {
    const diffArgs = ["diff", "--no-color", "--end-of-options", base];
    let text: string;
    let truncated = false;

    try {
      const { stdout } = await execFileAsync("git", ["-C", wt, ...diffArgs], {
        signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
        maxBuffer: EXEC_MAX_BUFFER,
        env,
      });

      text = stdout;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;

      if (
        e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
        /maxBuffer length exceeded/i.test(e.message ?? "")
      ) {
        log.info(
          { worktreePath: wt, maxBuffer: EXEC_MAX_BUFFER },
          "diffWorkingTree truncated — diff exceeded EXEC_MAX_BUFFER",
        );
        text = await streamGitDiffTruncated(wt, diffArgs, env);
        truncated = true;
      } else {
        throw new MaisterError(
          "CONFLICT",
          `git diff HEAD failed: ${asError(err).message}`,
          { cause: asError(err) },
        );
      }
    }

    const { stdout: nameStatusRaw } = await execFileAsync(
      "git",
      [
        "-C",
        wt,
        "diff",
        "--name-status",
        "--no-color",
        "--end-of-options",
        base,
      ],
      {
        signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
        maxBuffer: EXEC_MAX_BUFFER,
        env,
      },
    );
    const nameStatus = parseNameStatusOutput(nameStatusRaw);

    return { text, truncated, nameStatus };
  });
}

export interface DiffFileEntry {
  path: string;
  status: string;
  oldPath?: string;
}

export interface DiffChangeStatEntry extends DiffFileEntry {
  additions: number;
  deletions: number;
  binary: boolean;
}

export type DiffNameStatusArgs = {
  worktreePath: string;
  baseRef: string;
  branch: string;
};

function parseNameStatusLine(line: string): DiffFileEntry {
  const parts = line.split("\t");
  const status = (parts[0] ?? "").charAt(0);
  const filePath = parts.length >= 3 ? parts[parts.length - 1] : parts[1];
  const oldPath = parts.length >= 3 ? parts[1] : undefined;

  if (!filePath) {
    throw new MaisterError(
      "CONFLICT",
      `git diff --name-status returned an invalid row: ${JSON.stringify(line)}`,
    );
  }

  return oldPath
    ? { path: filePath, status, oldPath }
    : { path: filePath, status };
}

function parseNameStatusOutput(stdout: string): DiffFileEntry[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map(parseNameStatusLine);
}

type ParsedNumstatEntry = {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
};

function parseNumstatCount(raw: string, line: string): number {
  if (raw === "-") return 0;

  const parsed = Number.parseInt(raw, 10);

  if (Number.isNaN(parsed)) {
    throw new MaisterError(
      "CONFLICT",
      `git diff --numstat returned an invalid count: ${JSON.stringify(line)}`,
    );
  }

  return parsed;
}

function parseNumstatPath(
  raw: string,
): Pick<ParsedNumstatEntry, "path" | "oldPath"> {
  const braceRename = raw.match(/^(.*)\{(.+) => (.+)\}(.*)$/);

  if (braceRename) {
    const [, prefix, oldName, newName, suffix] = braceRename;
    const oldPath = `${prefix}${oldName}${suffix}`;
    const filePath = `${prefix}${newName}${suffix}`;

    return { path: filePath, oldPath };
  }

  const arrow = " => ";

  if (raw.includes(arrow)) {
    const [oldPath, ...rest] = raw.split(arrow);
    const filePath = rest.join(arrow);

    return { path: filePath, oldPath };
  }

  return { path: raw };
}

function parseNumstatLine(line: string): ParsedNumstatEntry {
  const parts = line.split("\t");
  const additionsRaw = parts[0];
  const deletionsRaw = parts[1];
  const pathRaw = parts.slice(2).join("\t");

  if (!additionsRaw || !deletionsRaw || !pathRaw) {
    throw new MaisterError(
      "CONFLICT",
      `git diff --numstat returned an invalid row: ${JSON.stringify(line)}`,
    );
  }

  const binary = additionsRaw === "-" || deletionsRaw === "-";
  const pathInfo = parseNumstatPath(pathRaw);

  return {
    ...pathInfo,
    additions: parseNumstatCount(additionsRaw, line),
    deletions: parseNumstatCount(deletionsRaw, line),
    binary,
  };
}

function parseNumstatOutput(stdout: string): Map<string, ParsedNumstatEntry> {
  const entries = new Map<string, ParsedNumstatEntry>();

  for (const line of stdout.split("\n").filter((row) => row.length > 0)) {
    const entry = parseNumstatLine(line);

    entries.set(entry.path, entry);
    if (entry.oldPath) entries.set(entry.oldPath, entry);
  }

  return entries;
}

function combineNameStatusWithNumstat(
  nameStatus: DiffFileEntry[],
  numstatByPath: Map<string, ParsedNumstatEntry>,
): DiffChangeStatEntry[] {
  return nameStatus.map((entry) => {
    const stats =
      numstatByPath.get(entry.path) ??
      (entry.oldPath ? numstatByPath.get(entry.oldPath) : undefined);

    return {
      ...entry,
      additions: stats?.additions ?? 0,
      deletions: stats?.deletions ?? 0,
      binary: stats?.binary ?? false,
    };
  });
}

// M22 Phase 5 (T5.1): the changed-files summary for the workbench diff. 2-dot
// (`base..branch`) to match diffRunWorkspace's literal stored-base -> branch tree
// delta so the file list lines up with the rendered diff (and with the M18
// review-panel `diffRange`). Parses git's `--name-status` output: each line is
// `<STATUS>\t<path>` (or `R100\told\tnew` for renames/copies — take the NEW path,
// the last tab-field).
export async function diffNameStatus(
  args: DiffNameStatusArgs,
): Promise<DiffFileEntry[]> {
  const wt = validate(absolutePathSchema, args.worktreePath, "worktreePath");
  const base = validate(gitRefSchema, args.baseRef, "baseRef");
  const br = validate(branchNameSchema, args.branch, "branch");

  log.debug({ worktreePath: wt, baseRef: base, branch: br }, "diffNameStatus");

  try {
    const { stdout } = await runGit(wt, [
      "diff",
      "--name-status",
      "--no-color",
      "--end-of-options",
      `${base}..${br}`,
    ]);

    return parseNameStatusOutput(stdout);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };

    throw new MaisterError(
      "CONFLICT",
      `git diff --name-status ${base}..${br} failed: ${(e.stderr ?? e.message).toString().trim()}`,
      { cause: asError(err) },
    );
  }
}

export async function diffChangeStats(
  args: DiffNameStatusArgs,
): Promise<DiffChangeStatEntry[]> {
  const wt = validate(absolutePathSchema, args.worktreePath, "worktreePath");
  const base = validate(gitRefSchema, args.baseRef, "baseRef");
  const br = validate(branchNameSchema, args.branch, "branch");

  log.debug({ worktreePath: wt, baseRef: base, branch: br }, "diffChangeStats");

  try {
    const [nameStatus, { stdout: numstatRaw }] = await Promise.all([
      diffNameStatus({ worktreePath: wt, baseRef: base, branch: br }),
      runGit(wt, [
        "diff",
        "--numstat",
        "--no-color",
        "--find-renames",
        "--end-of-options",
        `${base}..${br}`,
      ]),
    ]);

    return combineNameStatusWithNumstat(
      nameStatus,
      parseNumstatOutput(numstatRaw),
    );
  } catch (err) {
    if (err instanceof MaisterError) throw err;
    const e = err as NodeJS.ErrnoException & { stderr?: string };

    throw new MaisterError(
      "CONFLICT",
      `git diff --numstat ${base}..${br} failed: ${(e.stderr ?? e.message).toString().trim()}`,
      { cause: asError(err) },
    );
  }
}

// HEAD-vs-working-tree change stats (untracked rendered as additions). Pass
// `baseRef` to diff an arbitrary commit → working tree instead of HEAD — used
// by the scratch inspector to show base→worktree changes (committed +
// uncommitted + untracked) since a scratch agent edits files without
// committing, so the commit-range `base..branch` diff would be empty.
export async function diffWorkingTreeChangeStats(
  worktreePath: string,
  baseRef: string = "HEAD",
): Promise<DiffChangeStatEntry[]> {
  const wt = validate(absolutePathSchema, worktreePath, "worktreePath");
  const base =
    baseRef === "HEAD" ? "HEAD" : validate(gitRefSchema, baseRef, "baseRef");

  log.debug({ worktreePath: wt, baseRef: base }, "diffWorkingTreeChangeStats");

  return await withIntentToAddTempIndex(wt, async (env) => {
    try {
      const [nameStatusResult, numstatResult] = await Promise.all([
        execFileAsync(
          "git",
          [
            "-C",
            wt,
            "diff",
            "--name-status",
            "--no-color",
            "--end-of-options",
            base,
          ],
          {
            signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
            maxBuffer: EXEC_MAX_BUFFER,
            env,
          },
        ),
        execFileAsync(
          "git",
          [
            "-C",
            wt,
            "diff",
            "--numstat",
            "--no-color",
            "--find-renames",
            "--end-of-options",
            base,
          ],
          {
            signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
            maxBuffer: EXEC_MAX_BUFFER,
            env,
          },
        ),
      ]);

      return combineNameStatusWithNumstat(
        parseNameStatusOutput(nameStatusResult.stdout),
        parseNumstatOutput(numstatResult.stdout),
      );
    } catch (err) {
      if (err instanceof MaisterError) throw err;
      const e = err as NodeJS.ErrnoException & { stderr?: string };

      throw new MaisterError(
        "CONFLICT",
        `git diff --numstat ${base} failed: ${(e.stderr ?? e.message).toString().trim()}`,
        { cause: asError(err) },
      );
    }
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

export type SnapshotDirtyWorktreeArgs = {
  worktreePath: string;
  commitMessage: string;
};

const commitMessageSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((message) => !message.includes("\0"), "commit message has no NUL");

export async function snapshotDirtyWorktree(
  args: SnapshotDirtyWorktreeArgs,
): Promise<boolean> {
  const wt = validate(absolutePathSchema, args.worktreePath, "worktreePath");
  const commitMessage = validate(
    commitMessageSchema,
    args.commitMessage,
    "commitMessage",
  );
  const porcelain = await statusPorcelain({ worktreePath: wt });

  if (porcelain.trim() === "") {
    return false;
  }

  await runGit(wt, ["add", "-A"]);

  const identityArgs = await commitIdentityArgs(wt);

  await runGit(wt, [
    ...identityArgs,
    "commit",
    "--no-verify",
    "-m",
    commitMessage,
  ]);

  return true;
}

export type SquashRunBranchArgs = {
  worktreePath: string;
  baseCommit: string;
  message: string;
};

export type SquashRunBranchResult = {
  squashed: boolean;
  collapsed: number;
  reason?: "no-commits" | "tree-drift" | "git-error";
};

const baseShaSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{7,64}$/, "baseCommit must be a hex commit SHA");

// C2 (execution-policy commits=squash_rework / squash_on_promote): collapse the
// run branch's commits (base..HEAD) into ONE commit pre-promote — a deterministic
// engine op, NOT an agent node. `git reset --soft <base>` keeps the index/worktree
// intact, so the single re-commit records the SAME tree. The ★ tree-preserving
// guard verifies HEAD^{tree} is byte-identical before/after; ANY drift (or any git
// failure) reverts to the original HEAD and reports not-squashed so the caller
// falls back to keep_all — a botched history NEVER promotes. <=1 commit is a no-op.
export async function squashRunBranch(
  args: SquashRunBranchArgs,
): Promise<SquashRunBranchResult> {
  const wt = validate(absolutePathSchema, args.worktreePath, "worktreePath");
  const message = validate(commitMessageSchema, args.message, "squash message");
  const base = validate(baseShaSchema, args.baseCommit, "baseCommit");

  // Best-effort by contract: ANY git failure returns not-squashed so the caller
  // promotes the original history (keep_all) — squash never fails a promote.
  let oldHead: string | null = null;

  try {
    oldHead = (await runGit(wt, ["rev-parse", "HEAD"])).stdout.trim();
    const oldTree = (
      await runGit(wt, ["rev-parse", "HEAD^{tree}"])
    ).stdout.trim();

    const collapsed = Number.parseInt(
      (
        await runGit(wt, ["rev-list", "--count", `${base}..HEAD`])
      ).stdout.trim(),
      10,
    );

    if (!Number.isFinite(collapsed) || collapsed <= 1) {
      return { squashed: false, collapsed: 0, reason: "no-commits" };
    }

    await runGit(wt, ["reset", "--soft", base]);

    const identityArgs = await commitIdentityArgs(wt);

    await runGit(wt, [...identityArgs, "commit", "--no-verify", "-m", message]);

    const newTree = (
      await runGit(wt, ["rev-parse", "HEAD^{tree}"])
    ).stdout.trim();

    if (newTree !== oldTree) {
      await runGit(wt, ["reset", "--hard", oldHead]);
      log.error(
        { worktreePath: wt, oldTree, newTree },
        "[squash] tree drift after rewrite — reverted to original HEAD (keep_all)",
      );

      return { squashed: false, collapsed: 0, reason: "tree-drift" };
    }

    log.info(
      { worktreePath: wt, collapsed },
      "[squash] run branch collapsed to one commit (tree preserved)",
    );

    return { squashed: true, collapsed };
  } catch (err) {
    if (oldHead) {
      await runGit(wt, ["reset", "--hard", oldHead]).catch(() => undefined);
    }
    log.error(
      { worktreePath: wt, err: asError(err).message },
      "[squash] rewrite failed — reverted to original HEAD (keep_all)",
    );

    return { squashed: false, collapsed: 0, reason: "git-error" };
  }
}

// M30 (ADR-082, dirty-resolution "Discard"): drop ALL uncommitted work in the
// worktree — staged + unstaged restored to HEAD, untracked source removed.
// `git clean -fd`, never `-fdx` (ADR-079 §3: ignored build caches and an
// ignored .maister/ survive). Hard containment guard: refuses when the
// runtime artifacts root resolves inside the worktree, since a non-ignored
// artifacts path could otherwise be reached by the clean. v1 all-or-nothing.
// Callers re-run bundle materialization afterwards (ADR-079 §4).
export async function discardWorktree(worktreePath: string): Promise<void> {
  const wt = validate(absolutePathSchema, worktreePath, "worktreePath");

  // Shared DD10 guard (ADR-079 §5): refuse when the runtime artifacts root
  // resolves inside the worktree, so `git clean -fd` can never reach it.
  try {
    containmentAssert(wt);
  } catch (err) {
    log.error(
      { worktreePath: wt },
      "[dirty] discard refused — runtime artifacts root resolves inside the worktree",
    );

    throw err;
  }

  await runGit(wt, ["restore", "--staged", "--worktree", "."]);
  await runGit(wt, ["clean", "-fd"]);

  log.info({ worktreePath: wt }, "[dirty] worktree discarded to HEAD");
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
        // --full-tree lists from the repo root regardless of CWD, so a repo_path
        // that is itself a nested subdirectory of a larger repo can't silently
        // list that subdir's (often empty) subtree instead of the real root.
        dir === ""
          ? ["ls-tree", "-z", "--full-tree", "--end-of-options", ref]
          : [
              "ls-tree",
              "-z",
              "--full-tree",
              "--end-of-options",
              ref,
              "--",
              `${dir}/`,
            ],
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
