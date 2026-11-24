import "server-only";

import type { Db } from "./db";

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { GIT_OBJECT_ID } from "../../../runtime/wait-head";

import { executionAssignments, workspaces } from "@/lib/db/schema";

const workspaceDiff = z
  .object({
    handle: z.string().regex(/^ws_[a-f0-9]{32}$/),
    generation: z.number().int().positive(),
    base: z.string().regex(GIT_OBJECT_ID),
    head: z.string().regex(GIT_OBJECT_ID).nullable(),
  })
  .strict();

/** Verify the owner of the retained checkout, including after its Run releases capacity. */
export async function hasRetainedWorkspaceDiffOwner(
  db: Db,
  input: Readonly<{
    runId: string;
    executionHostId: string;
    assignmentId: string;
    assignmentEpoch: number;
    range: unknown;
  }>,
): Promise<boolean> {
  const parsed = workspaceDiff.safeParse(input.range);
  if (!parsed.success) return false;
  const { handle, generation } = parsed.data;
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
