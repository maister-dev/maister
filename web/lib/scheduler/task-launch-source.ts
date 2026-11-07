import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  TaskLaunchServerSource,
  TaskLaunchServerSourceSnapshot,
} from "@/lib/tasks/launch-server-source";

import { and, eq, sql } from "drizzle-orm";

import {
  projects,
  schedulerJobs,
  schedulerJobRuns,
  tasks,
} from "@/lib/db/schema";
import { retryDigest } from "@/lib/agents/retry-guards";
import { createTaskLaunchServerSource } from "@/lib/tasks/launch-server-source";
import { launchRefusal } from "@/lib/tasks/launch-resolution";

export type ScheduledJobLaunchIdentity = Readonly<{
  jobId: string;
  attemptId: string;
}>;

export async function loadScheduledJobLaunchScope(
  db: Db,
  identity: ScheduledJobLaunchIdentity,
): Promise<{
  projectId: string;
  taskId: string;
  target: Record<string, unknown>;
  snapshot: TaskLaunchServerSourceSnapshot;
}> {
  const [row] = await db
    .select({ job: schedulerJobs, attempt: schedulerJobRuns })
    .from(schedulerJobRuns)
    .innerJoin(schedulerJobs, eq(schedulerJobs.id, schedulerJobRuns.jobId))
    .where(
      and(
        eq(schedulerJobRuns.id, identity.attemptId),
        eq(schedulerJobs.id, identity.jobId),
      ),
    );
  const taskId = row?.job.target.taskId;

  if (
    !row ||
    row.job.jobKind !== "flow_run" ||
    row.attempt.jobKind !== "flow_run" ||
    row.job.disabledAt ||
    typeof taskId !== "string"
  )
    throw launchRefusal("launch_source_unavailable", "PRECONDITION");
  const [task] = await db
    .select({ projectId: tasks.projectId, archivedAt: projects.archivedAt })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId));

  if (
    !task ||
    task.archivedAt ||
    (row.job.projectId !== null && row.job.projectId !== task.projectId)
  )
    throw launchRefusal("launch_source_unavailable", "PRECONDITION");
  const execution = {
    triggerSource: "scheduled" as const,
    triggerPayload: {
      schedulerJobId: row.job.id,
      schedulerAttemptId: row.attempt.id,
    },
    launchMode: "auto" as const,
  };
  const snapshot: TaskLaunchServerSourceSnapshot = {
    version: 1,
    kind: "scheduled_job",
    id: row.attempt.id,
    projectId: task.projectId,
    taskId,
    execution,
    revisionDigest: retryDigest({
      jobId: row.job.id,
      attemptId: row.attempt.id,
      projectId: task.projectId,
      taskId,
      target: row.job.target,
      cadenceIntervalSeconds: row.job.cadenceIntervalSeconds,
    }),
  };

  return {
    projectId: task.projectId,
    taskId,
    target: row.job.target,
    snapshot,
  };
}

/** Creation requires the live scheduler claim; the accepted decision remains durable after acknowledgement. */
export async function scheduledJobTaskLaunchSource(
  db: Db,
  identity: ScheduledJobLaunchIdentity,
): Promise<TaskLaunchServerSource> {
  const current = await loadScheduledJobLaunchScope(db, identity);
  const claim = await db.execute(
    sql`SELECT 1 FROM scheduler_job_runs WHERE id=${identity.attemptId} AND job_id=${identity.jobId} AND status='Running' AND lease_expires_at>clock_timestamp()`,
  );

  if (!claim.rows.length) throw launchRefusal("launch_source_fenced");

  return createTaskLaunchServerSource(
    db,
    current.snapshot,
    assertStoredScheduledJobLaunchSource,
  );
}

export async function assertStoredScheduledJobLaunchSource(
  db: Db,
  source: TaskLaunchServerSourceSnapshot,
): Promise<void> {
  const jobId = source.execution.triggerPayload?.schedulerJobId;

  if (source.kind !== "scheduled_job" || typeof jobId !== "string")
    throw launchRefusal("launch_source_snapshot_incomplete", "PRECONDITION");
  const current = await loadScheduledJobLaunchScope(db, {
    jobId,
    attemptId: source.id,
  });

  if (retryDigest(current.snapshot) !== retryDigest(source))
    throw launchRefusal("launch_source_changed", "PRECONDITION");
}
