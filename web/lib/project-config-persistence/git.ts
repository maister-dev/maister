import "server-only";

import {
  GIT_OWNERSHIP_UNCERTAIN,
  executeReviewedRepositoryGit,
} from "./git-process";

import { MaisterError } from "@/lib/errors";

export async function gitResult(
  repo: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr?: string }> {
  try {
    const { stdout } = await executeReviewedRepositoryGit(repo, args, {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });

    return { code: 0, stdout };
  } catch (error) {
    if (error instanceof MaisterError) throw error;
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };

    if (failure.stderr?.includes(GIT_OWNERSHIP_UNCERTAIN))
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "Owned Git children did not retire normally. Inspect repository hooks and recover the recorded operation before retrying.",
        {
          details: { reason: "recovery_required" },
          cause: error instanceof Error ? error : undefined,
        },
      );

    if (typeof failure.code === "number" && !failure.killed) {
      return {
        code: failure.code,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      };
    }

    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Repository inspection failed; check Git availability and repository access.",
      {
        details: { reason: "repository_unavailable" },
        cause: error instanceof Error ? error : undefined,
      },
    );
  }
}

export async function git(
  repo: string,
  args: readonly string[],
): Promise<string> {
  const result = await gitResult(repo, args);

  if (result.code !== 0) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Git operation failed; inspect repository access and operation receipts before retrying.",
      {
        details: { reason: "repository_unavailable", exitCode: result.code },
      },
    );
  }

  return result.stdout;
}
