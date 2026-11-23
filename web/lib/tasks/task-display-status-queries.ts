import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { runs, taskClarifications, taskRelations, tasks, workspaces } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import type { Db } from "@/lib/execution-host/db";
import { taskRelationBlockerPredicate } from "@/lib/social/relations";
import { openBlockingClarificationPredicate } from "@/lib/tasks/clarification-gate";
import {
  incomingWorkPredicate,
  manualBacklogAdmissionPredicate,
  taskQualificationAdmittedPredicate,
} from "@/lib/tasks/qualification-predicates";
import { deriveTaskDisplayStatus, type TaskDisplayStatus } from "@/lib/tasks/task-display-status";

export function taskDisplayLatestFlow(db: Db) {
  return db
    .select({ status: runs.status, removedAt: workspaces.removedAt })
    .from(runs)
    .leftJoin(workspaces, eq(workspaces.runId, runs.id))
    .where(and(eq(runs.taskId, tasks.id), eq(runs.projectId, tasks.projectId), eq(runs.runKind, "flow")))
    .orderBy(desc(runs.startedAt), desc(runs.id))
    .limit(1)
    .as("latest_display_flow");
}

export function taskDisplayStatusColumns(latestFlow: ReturnType<typeof taskDisplayLatestFlow>) {
  return {
      taskStatus: tasks.status,
      triageStatus: tasks.triageStatus,
      triageFlagOrigin: tasks.triageFlagOrigin,
      configuredFlow: sql<boolean>`${tasks.flowId} IS NOT NULL`,
      incoming: sql<boolean>`${incomingWorkPredicate()}`,
      qualificationAdmitted: sql<boolean>`${taskQualificationAdmittedPredicate()}`,
      manualAdmission: sql<boolean>`${manualBacklogAdmissionPredicate()}`,
      blocked: sql<boolean>`(
        EXISTS (SELECT 1 FROM ${taskClarifications}
          WHERE ${taskClarifications.taskId}=${tasks.id}
          AND ${openBlockingClarificationPredicate()})
        OR EXISTS (SELECT 1 FROM ${taskRelations} relation
          JOIN ${tasks} blocker ON
            (relation.kind='blocks' AND relation.to_task_id=${tasks.id} AND blocker.id=relation.from_task_id)
            OR (relation.kind IN ('depends_on','requires') AND relation.from_task_id=${tasks.id} AND blocker.id=relation.to_task_id)
          WHERE ${taskRelationBlockerPredicate(sql`relation.kind`, sql`blocker.status`)})
      )`,
      latestFlowStatus: latestFlow.status,
      removedAt: latestFlow.removedAt,
  };
}

/** Loads only IDs already authorized by the caller. All facts use one statement snapshot. */
export async function getTaskDisplayStatuses(
  authorizedTaskIds: readonly string[],
  db: Db = getDb(),
): Promise<Map<string, TaskDisplayStatus>> {
  if (authorizedTaskIds.length === 0) return new Map();

  const latestFlow = taskDisplayLatestFlow(db);
  const rows = await db
    .select({ id: tasks.id, ...taskDisplayStatusColumns(latestFlow) })
    .from(tasks)
    .leftJoinLateral(latestFlow, sql`true`)
    .where(inArray(tasks.id, authorizedTaskIds));

  return new Map(rows.map(({ id, removedAt, ...facts }) => [
    id,
    deriveTaskDisplayStatus({ ...facts, workspaceRemoved: removedAt !== null }),
  ]));
}

export function requireTaskDisplayStatus(
  statuses: ReadonlyMap<string, TaskDisplayStatus>,
  taskId: string,
): TaskDisplayStatus {
  const status = statuses.get(taskId);

  if (!status) {
    throw new MaisterError("PRECONDITION", "Authorized task status is unavailable", {
      details: { taskId, operation: "getTaskDisplayStatuses" },
    });
  }

  return status;
}
