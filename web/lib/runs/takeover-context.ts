import "server-only";

import type { ArtifactInstance, Workspace } from "@/lib/db/schema";
import type { Db as ExecutionHostDb } from "@/lib/execution-host/db";

import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { readAddressedWorkspaceStatus } from "@/lib/execution-host/workspace-preparation";
import {
  readAddressedWorkspaceCommitSet,
  readAddressedWorkspacePatch,
} from "@/lib/execution-host/workspace-review";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projects } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

// M11b (ADR-030): the return route resolves the merge-base against the
// project's default branch. `loadRun` returns only the project slug, so the
// `main_branch` is read here. Server-state only — never a body field.
export async function loadProjectMainBranch(
  projectId: string,
  db?: Db,
): Promise<string> {
  const d = db ?? getDb();
  const rows: Array<{ mainBranch: string }> = await d
    .select({ mainBranch: projects.mainBranch })
    .from(projects)
    .where(eq(projects.id, projectId));

  const mainBranch = rows[0]?.mainBranch;

  if (!mainBranch) {
    throw new MaisterError(
      "PRECONDITION",
      `project ${projectId} not found or has no main branch`,
    );
  }

  return mainBranch;
}

export type TakeoverArtifactEvidence = Pick<ArtifactInstance, "locator"> &
  Partial<Pick<ArtifactInstance, "hash" | "sizeBytes">>;
export type TakeoverReturnEvidence = Readonly<{
  baseRef: string;
  headRef: string;
  returnedCommits: string;
  returnedDiff: string;
  operatorCommitCount: number;
  commitArtifact: TakeoverArtifactEvidence;
  diffArtifact: TakeoverArtifactEvidence;
}>;

/** Read the selected checkout's exact committed return before the manager claim transaction. */
export async function readAddressedTakeoverReturn(
  input: Readonly<{
    db: ExecutionHostDb;
    workspace: Workspace;
    claimHeadSha: string | null;
    signal: AbortSignal;
  }>,
): Promise<TakeoverReturnEvidence> {
  const { db, workspace, claimHeadSha } = input;
  const status = await readAddressedWorkspaceStatus(db, workspace);
  if (status.workingTree !== "clean")
    throw new MaisterError(
      "CONFLICT",
      "Commit or discard changes on the selected workspace before returning takeover",
    );
  const { observedCommit: head } = status.workspace;
  const base = workspace.baseCommit;
  if (!claimHeadSha || !head || !base)
    throw new MaisterError(
      "PRECONDITION",
      "The workspace's claim, base or returned commit cannot be verified",
    );
  if (head === claimHeadSha)
    throw new MaisterError(
      "CONFLICT",
      "The selected workspace has no new commits to return",
    );
  const [commits, diff, operator] = await Promise.all([
    readAddressedWorkspaceCommitSet({ ...input, base, head }),
    readAddressedWorkspacePatch({ ...input, range: { base, head } }),
    claimHeadSha === base
      ? null
      : readAddressedWorkspaceCommitSet({ ...input, base: claimHeadSha, head }),
  ]);
  const current = await readAddressedWorkspaceStatus(db, workspace);
  if (
    current.workingTree !== "clean" ||
    current.workspace.observedCommit !== head
  )
    throw new MaisterError(
      "CONFLICT",
      "The selected workspace changed while takeover return was being verified",
    );

  return {
    baseRef: base,
    headRef: head,
    returnedCommits: commits.text,
    returnedDiff: diff.patch,
    operatorCommitCount: (operator ?? commits).text
      .split("\n")
      .filter((line) => line.length > 0).length,
    commitArtifact: {
      locator: {
        kind: "execution-object",
        objectId: commits.reference.objectId,
      },
      hash: commits.reference.sha256,
      sizeBytes: commits.sizeBytes,
    },
    diffArtifact: {
      locator: { kind: "execution-object", objectId: diff.reference.objectId },
      hash: diff.reference.sha256,
      sizeBytes: diff.sizeBytes,
    },
  };
}
