import "server-only";

import type { Db } from "./db";

import { and, eq, isNull } from "drizzle-orm";

import { configuredSelectedExecutionEndpoint } from "./selected-endpoint";

import { projects, runs, taskLaunchIntents, workspaceInputCaptures, workspaces } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { assertTaskLaunchUserAuthority } from "@/lib/tasks/launch-authority";
import { assertTaskLaunchDispatchAuthority } from "@/lib/tasks/launch-dispatch-authority";

/** Use the current Run principal. Bytes in a retained capture grant no authority. */
export async function assertWorkspaceRunAuthority(
  db: Db,
  runId: string,
): Promise<void> {
  const [run] = await db
    .select({
      projectId: runs.projectId,
      userId: runs.createdByUserId,
      intentId: runs.taskLaunchIntentId,
      originalUserId: workspaceInputCaptures.originUserId,
    })
    .from(runs)
    .innerJoin(workspaces, and(eq(workspaces.runId, runs.id),
      eq(workspaces.preparationAssignmentId, runs.executionAssignmentId)))
    .innerJoin(workspaceInputCaptures, eq(workspaceInputCaptures.workspaceId, workspaces.id))
    .where(and(eq(runs.id, runId), isNull(workspaces.removedAt)));

  if (!run?.projectId)
    throw new MaisterError(
      "PRECONDITION",
      "Workspace input dispatch requires an active project launch",
      {
        details: { reason: "workspace_preparation_changed" },
      },
    );
  if (run.userId !== run.originalUserId)
    throw new MaisterError("UNAUTHORIZED", "The addressed Run's launch principal is no longer active", {
      details: { reason: "launch_authority_revoked" },
    });
  if (run.intentId) {
    const [intent] = await db
      .select()
      .from(taskLaunchIntents)
      .where(
        and(
          eq(taskLaunchIntents.id, run.intentId),
          eq(taskLaunchIntents.projectId, run.projectId),
        ),
      )
      .for("share");
    if (!intent)
      throw new MaisterError(
        "UNAUTHORIZED",
        "Workspace input launch authority is unavailable",
        {
          details: { reason: "launch_authority_revoked" },
        },
      );
    await assertTaskLaunchDispatchAuthority(db, intent);

    return;
  }
  if (run.userId) {
    await assertTaskLaunchUserAuthority(db, run.projectId, run.userId, [
      "launchRun",
    ]);

    return;
  }
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, run.projectId), isNull(projects.archivedAt)))
    .for("share");
  if (!project)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Workspace input launch project is archived or missing",
      {
        details: { reason: "launch_authority_revoked" },
      },
    );
}

/** Legacy sessions use their existing admission authority. */
export async function assertAddressedWorkspaceSessionAuthority(db: Db, runId: string): Promise<void> {
  if (!configuredSelectedExecutionEndpoint()) return;
  const [workspace] = await db.select({ id: workspaces.id }).from(workspaces).where(and(
    eq(workspaces.runId, runId), eq(workspaces.ownershipKind, "host_owned"), isNull(workspaces.removedAt),
  )).limit(1);
  if (workspace) await assertWorkspaceRunAuthority(db, runId);
}
