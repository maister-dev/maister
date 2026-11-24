import type {
  WorkspaceGitReview,
  WorkspaceGitReviewFile,
} from "../../runtime/workspace-prepare";
import type { WorkspaceRow } from "./host-state";

import { SupervisorError } from "./types";
import { withPreparedGitIndex } from "./workspace-git-index";
import { executeWorkspaceGitBytes } from "./workspace-source";

function invalidStats(): SupervisorError {
  return new SupervisorError(
    "PRECONDITION",
    "The workspace review has inconsistent Git statistics",
    {
      details: { reason: "workspace_diff_range_invalid" },
    },
  );
}

function nulFields(bytes: Buffer): string[] {
  const fields = new TextDecoder("utf-8", { fatal: true })
    .decode(bytes)
    .split("\0");
  if (fields.pop() !== "") throw invalidStats();

  return fields;
}

function parseFileStats(
  names: Buffer,
  counts: Buffer,
): WorkspaceGitReviewFile[] {
  const entries = nulFields(names);
  const stats = nulFields(counts);
  const files: WorkspaceGitReviewFile[] = [];
  let statIndex = 0;
  for (let index = 0; index < entries.length;) {
    const status = entries[index++][0];
    if (
      status !== "A" &&
      status !== "C" &&
      status !== "D" &&
      status !== "M" &&
      status !== "R" &&
      status !== "T"
    )
      throw invalidStats();
    const isPair = status === "R" || status === "C";
    const oldPath = isPair ? entries[index++] : undefined;
    const path = entries[index++];
    const fields = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(
      stats[statIndex++] ?? "",
    );
    if (!fields || !path) throw invalidStats();
    const [, added, removed, statPath] = fields;
    if (isPair) {
      if (
        !oldPath ||
        statPath !== "" ||
        stats[statIndex++] !== oldPath ||
        stats[statIndex++] !== path
      )
        throw invalidStats();
    } else if (statPath !== path) throw invalidStats();
    const binary = added === "-";
    const additions = binary ? 0 : Number(added);
    const deletions = binary ? 0 : Number(removed);
    if (
      binary !== (removed === "-") ||
      !Number.isSafeInteger(additions) ||
      !Number.isSafeInteger(deletions)
    )
      throw invalidStats();
    files.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      status,
      additions,
      deletions,
      binary,
    });
  }
  if (statIndex !== stats.length) throw invalidStats();

  return files;
}

/** Capture one temporary index so patch and native Git stats describe identical bytes. */
export async function readWorkspaceReviewSnapshot(
  workspace: WorkspaceRow,
  git: readonly string[],
  baseCommit: string,
): Promise<WorkspaceGitReview> {
  return withPreparedGitIndex(workspace, git, async (indexFile) => {
    await executeWorkspaceGitBytes([...git, "add", "-A", "--", "."], {
      indexFile,
    });
    const diff = [
      ...git,
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--find-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
    ];
    const [patch, names, counts] = await Promise.all([
      executeWorkspaceGitBytes([...diff, baseCommit, "--"], { indexFile }),
      executeWorkspaceGitBytes(
        [...diff, "--name-status", "-z", baseCommit, "--"],
        { indexFile },
      ),
      executeWorkspaceGitBytes([...diff, "--numstat", "-z", baseCommit, "--"], {
        indexFile,
      }),
    ]);

    return {
      baseCommit,
      patch: new TextDecoder("utf-8", { fatal: true }).decode(patch),
      files: parseFileStats(names, counts),
    };
  });
}
