import "server-only";

import type { Db } from "./db";

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { GIT_OBJECT_ID } from "../../../runtime/wait-head";
import {
  WORKSPACE_LOG_MAX_BYTES,
  WORKSPACE_COMMIT_SET_OBJECT_NAME,
  WORKSPACE_LOG_OBJECT_NAME,
  WORKSPACE_REVIEW_MAX_BYTES,
  WORKSPACE_REVIEW_OBJECT_NAME,
} from "../../../runtime/workspace-prepare";

import { executionAssignments, workspaces } from "@/lib/db/schema";

const workspaceIdentity = z.object({
  handle: z.string().regex(/^ws_[a-f0-9]{32}$/),
  generation: z.number().int().positive(),
});
const workspaceDiff = workspaceIdentity
  .extend({
    base: z.string().regex(GIT_OBJECT_ID),
    head: z.string().regex(GIT_OBJECT_ID).nullable(),
    format: z.literal("review").optional(),
  })
  .strict();
const workspaceLog = workspaceIdentity
  .extend({
    head: z.string().regex(GIT_OBJECT_ID),
    base: z.string().regex(GIT_OBJECT_ID).optional(),
  })
  .strict();

export function carriesWorkspaceGitEvidence(
  payload: Readonly<Record<string, unknown>>,
): boolean {
  return (
    payload.workspaceGitDiff !== undefined ||
    payload.workspaceGitLog !== undefined
  );
}

export function workspaceGitEvidence(
  payload: Readonly<Record<string, unknown>>,
): {
  handle: string;
  generation: number;
  logicalName: string;
  mimeType: string;
  maxBytes: number;
} | null {
  if (
    payload.workspaceGitDiff !== undefined &&
    payload.workspaceGitLog !== undefined
  )
    return null;
  if (payload.workspaceGitDiff !== undefined) {
    const parsed = workspaceDiff.safeParse(payload.workspaceGitDiff);

    return parsed.success
      ? {
          ...parsed.data,
          logicalName:
            parsed.data.format === "review"
              ? WORKSPACE_REVIEW_OBJECT_NAME
              : "workspace-diff.patch",
          mimeType:
            parsed.data.format === "review"
              ? "application/json"
              : "text/x-diff",
          maxBytes:
            parsed.data.format === "review"
              ? WORKSPACE_REVIEW_MAX_BYTES
              : 64 * 1024,
        }
      : null;
  }
  const parsed = workspaceLog.safeParse(payload.workspaceGitLog);

  return parsed.success
    ? {
        ...parsed.data,
        logicalName: parsed.data.base
          ? WORKSPACE_COMMIT_SET_OBJECT_NAME
          : WORKSPACE_LOG_OBJECT_NAME,
        mimeType: parsed.data.base ? "text/plain" : "application/json",
        maxBytes: WORKSPACE_LOG_MAX_BYTES,
      }
    : null;
}

/** Verify the owner of the retained checkout, including after its Run releases capacity. */
export async function hasRetainedWorkspaceGitOwner(
  db: Db,
  input: Readonly<{
    runId: string;
    executionHostId: string;
    assignmentId: string;
    assignmentEpoch: number;
    handle: string;
    generation: number;
  }>,
): Promise<boolean> {
  const { handle, generation } = input;
  const [owner] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .innerJoin(
      executionAssignments,
      eq(executionAssignments.id, workspaces.preparationAssignmentId),
    )
    .where(
      and(
        eq(workspaces.runId, input.runId),
        eq(workspaces.ownershipKind, "host_owned"),
        eq(workspaces.executionHostId, input.executionHostId),
        eq(workspaces.executionWorkspaceId, handle),
        eq(workspaces.workspaceGeneration, generation),
        isNull(workspaces.removedAt),
        eq(executionAssignments.id, input.assignmentId),
        eq(executionAssignments.runId, input.runId),
        eq(executionAssignments.executionHostId, input.executionHostId),
        eq(executionAssignments.epoch, input.assignmentEpoch),
        eq(executionAssignments.executionWorkspaceId, handle),
      ),
    )
    .limit(1);

  return owner !== undefined;
}
