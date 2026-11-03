import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ScheduledLaunchReservation } from "./types";
import type {
  TaskLaunchServerSource,
  TaskLaunchServerSourceSnapshot,
} from "@/lib/tasks/launch-server-source";

import { and, eq, sql } from "drizzle-orm";

import {
  projects,
  scheduledTaskLaunches,
  scheduledTaskLaunchAttempts,
  tasks,
} from "@/lib/db/schema";
import { retryDigest } from "@/lib/agents/retry-guards";
import { createTaskLaunchServerSource } from "@/lib/tasks/launch-server-source";
import { launchRefusal } from "@/lib/tasks/launch-resolution";

export async function loadScheduledTaskLaunchScope(
  db: Db,
  scheduledLaunchId: string,
  reservationId: string,
  acceptedClaimFence?: number,
): Promise<{
  snapshot: TaskLaunchServerSourceSnapshot;
  reservation: ScheduledLaunchReservation;
}> {
  const [row] = await db
    .select({
      launch: scheduledTaskLaunches,
      reservation: scheduledTaskLaunchAttempts,
      taskProjectId: tasks.projectId,
      archivedAt: projects.archivedAt,
    })
    .from(scheduledTaskLaunches)
    .innerJoin(
      scheduledTaskLaunchAttempts,
      eq(
        scheduledTaskLaunchAttempts.scheduledLaunchId,
        scheduledTaskLaunches.id,
      ),
    )
    .innerJoin(tasks, eq(tasks.id, scheduledTaskLaunches.taskId))
    .innerJoin(projects, eq(projects.id, scheduledTaskLaunches.projectId))
    .where(
      and(
        eq(scheduledTaskLaunches.id, scheduledLaunchId),
        eq(scheduledTaskLaunchAttempts.id, reservationId),
      ),
    );

  if (
    !row ||
    !row.launch.taskId ||
    row.archivedAt ||
    row.taskProjectId !== row.launch.projectId ||
    !["Dispatching", "Launched"].includes(row.launch.state) ||
    !["Reserved", "Materialized", "RunLinked"].includes(
      row.reservation.state,
    ) ||
    row.launch.requestHash !== row.reservation.requestHash
  )
    throw launchRefusal("launch_source_unavailable", "PRECONDITION");
  const reservation: ScheduledLaunchReservation = {
    id: row.reservation.id,
    scheduledLaunchId,
    runId: row.reservation.runId,
    taskId: row.launch.taskId,
    taskAttemptNumber: row.reservation.taskAttemptNumber,
    branch: row.reservation.branch,
    worktreePath: row.reservation.worktreePath,
    requestHash: row.reservation.requestHash,
    claimFence: acceptedClaimFence ?? row.reservation.claimFence,
  };
  const fixedAllocation = {
    runId: reservation.runId,
    taskAttemptNumber: reservation.taskAttemptNumber,
    branch: reservation.branch,
    worktreePath: reservation.worktreePath,
  };
  const snapshot: TaskLaunchServerSourceSnapshot = {
    version: 1,
    kind: "scheduled_task",
    id: `${scheduledLaunchId}:${row.launch.revision}`,
    projectId: row.launch.projectId,
    taskId: row.launch.taskId,
    revisionDigest: retryDigest({
      scheduledLaunchId,
      revision: row.launch.revision,
      requestHash: row.launch.requestHash,
      request: row.launch.launchRequest,
      scheduledForAt: row.launch.scheduledForAt.toISOString(),
      reservationId: reservation.id,
      fixedAllocation,
    }),
    execution: {
      scheduledReservation: reservation,
      allowConcurrent: false,
      triggerSource: "scheduled",
      launchMode: "auto",
    },
    fixedAllocation,
  };

  return { snapshot, reservation };
}

/** Transient claim ownership admits the fire; the frozen logical reservation survives lease recovery. */
export async function scheduledTaskLaunchSource(
  db: Db,
  input: {
    scheduledLaunchId: string;
    reservationId: string;
    claimId: string;
    claimFence: number;
  },
): Promise<TaskLaunchServerSource> {
  const scope = await loadScheduledTaskLaunchScope(
    db,
    input.scheduledLaunchId,
    input.reservationId,
  );
  const claim = await db.execute(
    sql`SELECT 1 FROM scheduled_task_launches WHERE id=${input.scheduledLaunchId} AND state='Dispatching' AND claim_id=${input.claimId} AND claim_fence=${input.claimFence} AND claim_expires_at>clock_timestamp()`,
  );

  if (!claim.rows.length || scope.reservation.claimFence !== input.claimFence)
    throw launchRefusal("launch_source_fenced");

  return createTaskLaunchServerSource(
    db,
    scope.snapshot,
    assertStoredScheduledTaskLaunchSource,
  );
}

export async function assertStoredScheduledTaskLaunchSource(
  db: Db,
  source: TaskLaunchServerSourceSnapshot,
): Promise<void> {
  const reservation = source.execution.scheduledReservation;

  if (
    source.kind !== "scheduled_task" ||
    !reservation ||
    !Number.isInteger(reservation.claimFence) ||
    reservation.claimFence < 1
  )
    throw launchRefusal("launch_source_snapshot_incomplete", "PRECONDITION");
  const current = await loadScheduledTaskLaunchScope(
    db,
    reservation.scheduledLaunchId,
    reservation.id,
    reservation.claimFence,
  );

  if (retryDigest(current.snapshot) !== retryDigest(source))
    throw launchRefusal("launch_source_changed", "PRECONDITION");
}
