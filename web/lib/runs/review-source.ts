import "server-only";

import type { DiffFileEntry } from "@/lib/worktree";
import type { Db } from "@/lib/execution-host/db";
import type { workspaces } from "@/lib/db/schema";
import type { WorkspaceGitReviewFile } from "../../../runtime/workspace-prepare";

import { createHash } from "node:crypto";

import { filterDiffByPath } from "@/lib/diff/prepare";
import { MaisterError } from "@/lib/errors";
import { readAddressedWorkspaceReviewSnapshot } from "@/lib/execution-host/workspace-review";
import { readAddressedWorkspaceReviewFingerprint } from "@/lib/execution-host/workspace-preparation";
import {
  filterReviewableChangeEntries,
  isReviewableChangeEntry,
} from "@/lib/runs/reviewable-changes";
import { diffWorkingTree } from "@/lib/worktree";

export interface ReviewSourceFingerprintInput {
  baseCommit: string;
  diff: string;
  nameStatus: readonly DiffFileEntry[];
  truncated: boolean;
}

export interface ReviewSource {
  scope: "review";
  baseCommit: string;
  diff: string;
  nameStatus: DiffFileEntry[];
  truncated: boolean;
  fingerprint: string;
}

function requireReviewBase(workspace: typeof workspaces.$inferSelect): string {
  if (!workspace.baseCommit)
    throw new MaisterError(
      "PRECONDITION",
      "The selected workspace has no pinned review base",
    );

  return workspace.baseCommit;
}

/** Verify the current sealed snapshot without waiting on a projector that may need the Run lock. */
export async function readAddressedReviewFingerprint(
  db: Db,
  workspace: typeof workspaces.$inferSelect,
): Promise<Pick<ReviewSource, "scope" | "baseCommit" | "fingerprint">> {
  const baseCommit = requireReviewBase(workspace);
  const { sha256 } = await readAddressedWorkspaceReviewFingerprint(
    db,
    workspace,
    baseCommit,
  );

  return { scope: "review", baseCommit, fingerprint: `sha256:${sha256}` };
}

export async function readAddressedReviewSource(
  input: Readonly<{
    db: Db;
    workspace: typeof workspaces.$inferSelect;
    signal: AbortSignal;
  }>,
): Promise<ReviewSource & { files: WorkspaceGitReviewFile[] }> {
  const baseCommit = requireReviewBase(input.workspace);
  const raw = await readAddressedWorkspaceReviewSnapshot({
    ...input,
    range: { base: baseCommit },
  });
  const files = filterReviewableChangeEntries(raw.files);
  const diff = filterDiffByPath(raw.patch, (path, oldPath) =>
    isReviewableChangeEntry({ path, oldPath }),
  );
  const source = { baseCommit, diff, nameStatus: files, truncated: false };

  return {
    scope: "review",
    ...source,
    files,
    fingerprint: `sha256:${raw.sha256}`,
  };
}

function canonicalNameStatus(
  entries: readonly DiffFileEntry[],
): Array<{ path: string; oldPath: string | null; status: string }> {
  return entries.map((entry) => ({
    path: entry.path,
    oldPath: entry.oldPath ?? null,
    status: entry.status,
  }));
}

export function reviewSourceFingerprint(
  input: ReviewSourceFingerprintInput,
): string {
  const canonical = JSON.stringify({
    baseCommit: input.baseCommit,
    diff: input.diff,
    nameStatus: canonicalNameStatus(input.nameStatus),
    truncated: input.truncated,
  });

  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export async function readReviewSource(input: {
  worktreePath: string;
  baseCommit: string;
}): Promise<ReviewSource> {
  const workingTree = await diffWorkingTree(
    input.worktreePath,
    input.baseCommit,
  );
  const nameStatus = filterReviewableChangeEntries(workingTree.nameStatus);
  const diff = filterDiffByPath(workingTree.text, (path, oldPath) =>
    isReviewableChangeEntry({ path, oldPath }),
  );
  const fingerprint = reviewSourceFingerprint({
    baseCommit: input.baseCommit,
    diff,
    nameStatus,
    truncated: workingTree.truncated,
  });

  return {
    scope: "review",
    baseCommit: input.baseCommit,
    diff,
    nameStatus,
    truncated: workingTree.truncated,
    fingerprint,
  };
}
