import "server-only";

import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import pino from "pino";
import { z } from "zod";

import { MaisterError } from "@/lib/errors";

const execFileAsync = promisify(execFile);

const log = pino({
  name: "worktree",
  level: process.env.LOG_LEVEL ?? "info",
});

const GIT_TIMEOUT_MS = 60_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) => path.isAbsolute(p) && !p.split(path.sep).includes(".."),
    "must be absolute with no '..' segments",
  );

const branchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_./-]+$/, "branch must match /^[A-Za-z0-9_./-]+$/")
  .refine((b) => !b.includes(".."), "branch must not contain '..'")
  .refine((b) => !b.endsWith(".lock"), "branch must not end with .lock");

const refSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_./-]+$/, "ref must match /^[A-Za-z0-9_./-]+$/")
  .refine((r) => !r.includes(".."), "ref must not contain '..'")
  .refine((r) => !r.startsWith("-"), "ref must not start with '-'");

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

export type AddWorktreeArgs = {
  projectRepoPath: string;
  branch: string;
  worktreePath: string;
};

export async function addWorktree(args: AddWorktreeArgs): Promise<void> {
  const repo = validate(
    absolutePathSchema,
    args.projectRepoPath,
    "projectRepoPath",
  );
  const wt = validate(absolutePathSchema, args.worktreePath, "worktreePath");
  const br = validate(branchNameSchema, args.branch, "branch");

  log.info(
    { projectRepoPath: repo, branch: br, worktreePath: wt },
    "addWorktree",
  );

  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["-C", repo, "worktree", "add", "-b", br, wt],
      {
        signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
        maxBuffer: EXEC_MAX_BUFFER,
      },
    );

    log.debug({ stdout, stderr }, "addWorktree done");
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const stderrText = (e.stderr ?? e.message ?? "").toString();

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
      `git worktree add failed: ${stderrText.trim() || e.message}`,
      { cause: asError(err) },
    );
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
  const base = validate(refSchema, args.baseRef, "baseRef");
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
  const base = validate(refSchema, args.baseRef, "baseRef");
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
  const br = validate(branchNameSchema, args.branch, "branch");
  const main = validate(branchNameSchema, args.mainBranch, "mainBranch");

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
