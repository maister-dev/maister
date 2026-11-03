import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  TaskLaunchServerSource,
  TaskLaunchServerSourceSnapshot,
} from "@/lib/tasks/launch-server-source";

import { eq, sql } from "drizzle-orm";

import { projects, runSchedules, tasks } from "@/lib/db/schema";
import { retryDigest } from "@/lib/agents/retry-guards";
import { createTaskLaunchServerSource } from "@/lib/tasks/launch-server-source";
import { launchRefusal } from "@/lib/tasks/launch-resolution";

export function runScheduleTaskLaunchKey(
  scheduleId: string,
  fireAt: Date,
): string {
  return `${scheduleId}:${fireAt.getTime()}`;
}

export async function loadRunScheduleLaunchScope(
  db: Db,
  scheduleId: string,
  fireAt: Date,
): Promise<{
  projectId: string;
  taskId: string;
  runnerId: string | null;
  snapshot: TaskLaunchServerSourceSnapshot;
}> {
  const [row] = await db
    .select({
      schedule: runSchedules,
      taskProjectId: tasks.projectId,
      archivedAt: projects.archivedAt,
    })
    .from(runSchedules)
    .innerJoin(tasks, eq(tasks.id, runSchedules.taskId))
    .innerJoin(projects, eq(projects.id, runSchedules.projectId))
    .where(eq(runSchedules.id, scheduleId));

  if (
    !row ||
    row.archivedAt ||
    row.taskProjectId !== row.schedule.projectId ||
    !Number.isFinite(fireAt.getTime())
  )
    throw launchRefusal("launch_source_unavailable", "PRECONDITION");
  const schedule = row.schedule;
  const snapshot: TaskLaunchServerSourceSnapshot = {
    version: 1,
    kind: "run_schedule",
    id: runScheduleTaskLaunchKey(schedule.id, fireAt),
    projectId: schedule.projectId,
    taskId: schedule.taskId,
    revisionDigest: retryDigest({
      scheduleId: schedule.id,
      projectId: schedule.projectId,
      taskId: schedule.taskId,
      cronExpr: schedule.cronExpr,
      timezone: schedule.timezone,
      overlapPolicy: schedule.overlapPolicy,
      runnerId: schedule.runnerId,
      fireAt: fireAt.toISOString(),
    }),
    execution: {
      triggerSource: "scheduled",
      triggerPayload: {
        runScheduleId: schedule.id,
        scheduledFireAt: fireAt.toISOString(),
      },
      launchMode: "auto",
    },
  };

  return {
    projectId: schedule.projectId,
    taskId: schedule.taskId,
    runnerId: schedule.runnerId,
    snapshot,
  };
}

export async function runScheduleTaskLaunchSource(
  db: Db,
  input: { scheduleId: string; fireAt: Date; leaseAt: Date },
): Promise<TaskLaunchServerSource> {
  const scope = await loadRunScheduleLaunchScope(
    db,
    input.scheduleId,
    input.fireAt,
  );
  const claim = await db.execute(
    sql`SELECT 1 FROM run_schedules WHERE id=${input.scheduleId} AND last_fire_outcome='dispatching' AND last_fired_at=${input.fireAt} AND updated_at=${input.leaseAt}`,
  );

  if (!claim.rows.length) throw launchRefusal("launch_source_fenced");

  return createTaskLaunchServerSource(
    db,
    scope.snapshot,
    assertStoredRunScheduleLaunchSource,
  );
}

/** Later cron occurrences do not revoke an accepted fire; edits to its target or policy do. */
export async function assertStoredRunScheduleLaunchSource(
  db: Db,
  source: TaskLaunchServerSourceSnapshot,
): Promise<void> {
  const scheduleId = source.execution.triggerPayload?.runScheduleId;
  const fire = source.execution.triggerPayload?.scheduledFireAt;

  if (
    source.kind !== "run_schedule" ||
    typeof scheduleId !== "string" ||
    typeof fire !== "string"
  )
    throw launchRefusal("launch_source_snapshot_incomplete", "PRECONDITION");
  const current = await loadRunScheduleLaunchScope(
    db,
    scheduleId,
    new Date(fire),
  );

  if (retryDigest(current.snapshot) !== retryDigest(source))
    throw launchRefusal("launch_source_changed", "PRECONDITION");
}
