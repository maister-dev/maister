import "server-only";

import type {
  RunScheduleFireOutcome,
  RunScheduleOverlapPolicy,
  RunStatus,
  SchedulerJobKind,
  SchedulerJobRunStatus,
} from "@/lib/db/schema";
import type { SchedulerRunScheduleOverviewDataRow } from "@/types/scheduler";

import { sql, type SQL } from "drizzle-orm";

import { getDb } from "@/lib/db/client";

export type SchedulerStatusRow = {
  id: string;
  projectId: string | null;
  projectSlug: string | null;
  projectName: string | null;
  jobKind: SchedulerJobKind;
  target: Record<string, unknown>;
  cadenceIntervalSeconds: number;
  nextRunAt: Date;
  lastFiredAt: Date | null;
  disabledAt: Date | null;
  consecutiveFailures: number;
  maxFailures: number;
  lastStatus: SchedulerJobRunStatus | null;
  lastFinishedAt: Date | null;
  lastErrorCode: string | null;
};

export type SchedulerRunScheduleOverviewRow =
  SchedulerRunScheduleOverviewDataRow;

type SchedulerQueryDb = {
  execute(query: SQL): Promise<{ rows?: unknown[] }>;
};

type SchedulerStatusDbRow = {
  id: string;
  project_id: string | null;
  project_slug: string | null;
  project_name: string | null;
  job_kind: SchedulerJobKind;
  target: Record<string, unknown> | null;
  cadence_interval_seconds: number;
  next_run_at: Date | string;
  last_fired_at: Date | string | null;
  disabled_at: Date | string | null;
  consecutive_failures: number;
  max_failures: number;
  last_status: SchedulerJobRunStatus | null;
  last_finished_at: Date | string | null;
  last_error_code: string | null;
};

type SchedulerRunScheduleOverviewDbRow = {
  schedule_id: string;
  schedule_name: string;
  project_id: string;
  project_slug: string;
  project_name: string;
  task_id: string;
  task_number: number;
  task_title: string;
  task_status: "Backlog" | "InFlight" | "Done" | "Abandoned";
  cron_expr: string;
  timezone: string;
  overlap_policy: RunScheduleOverlapPolicy;
  runner_id: string | null;
  enabled: boolean;
  next_fire_at: Date | string;
  queue_one_pending: boolean;
  queued_fire_at: Date | string | null;
  last_fired_at: Date | string | null;
  last_fire_outcome: RunScheduleFireOutcome | null;
  last_fire_error: string | null;
  last_run_id: string | null;
  last_run_status: RunStatus | null;
};

export async function listSchedulerStatusRows(
  args: {
    limit?: number;
    db?: SchedulerQueryDb;
  } = {},
): Promise<SchedulerStatusRow[]> {
  const db = args.db ?? (getDb() as unknown as SchedulerQueryDb);
  const limit = args.limit ?? 50;
  const result = await db.execute(sql`
    SELECT
      j.id,
      j.project_id,
      p.slug AS project_slug,
      p.name AS project_name,
      j.job_kind,
      j.target,
      j.cadence_interval_seconds,
      j.next_run_at,
      j.last_fired_at,
      j.disabled_at,
      j.consecutive_failures,
      j.max_failures,
      r.status AS last_status,
      r.finished_at AS last_finished_at,
      r.error_code AS last_error_code
    FROM scheduler_jobs j
    LEFT JOIN projects p ON p.id = j.project_id
    LEFT JOIN LATERAL (
      SELECT status, finished_at, error_code
      FROM scheduler_job_runs
      WHERE job_id = j.id
      ORDER BY claimed_at DESC
      LIMIT 1
    ) r ON true
    ORDER BY j.next_run_at ASC, j.id ASC
    LIMIT ${limit}
  `);

  return (result.rows ?? []).map((row) =>
    toSchedulerStatusRow(row as SchedulerStatusDbRow),
  );
}

export async function listSchedulerRunScheduleOverviewRows(
  args: {
    limit?: number;
    db?: SchedulerQueryDb;
  } = {},
): Promise<SchedulerRunScheduleOverviewRow[]> {
  const db = args.db ?? (getDb() as unknown as SchedulerQueryDb);
  const limit = args.limit ?? 100;
  const result = await db.execute(sql`
    SELECT
      s.id AS schedule_id,
      s.name AS schedule_name,
      p.id AS project_id,
      p.slug AS project_slug,
      p.name AS project_name,
      t.id AS task_id,
      t.number AS task_number,
      t.title AS task_title,
      t.status AS task_status,
      s.cron_expr,
      s.timezone,
      s.overlap_policy,
      s.runner_id,
      s.enabled,
      s.next_fire_at,
      s.queue_one_pending,
      s.queued_fire_at,
      s.last_fired_at,
      s.last_fire_outcome,
      s.last_fire_error,
      s.last_run_id,
      r.status AS last_run_status
    FROM run_schedules s
    INNER JOIN projects p ON p.id = s.project_id
    INNER JOIN tasks t ON t.id = s.task_id
    LEFT JOIN runs r ON r.id = s.last_run_id
    WHERE p.archived_at IS NULL
    ORDER BY s.next_fire_at ASC, p.slug ASC, t.number ASC, s.name ASC
    LIMIT ${limit}
  `);

  return (result.rows ?? []).map((row) =>
    toSchedulerRunScheduleOverviewRow(row as SchedulerRunScheduleOverviewDbRow),
  );
}

function toSchedulerStatusRow(row: SchedulerStatusDbRow): SchedulerStatusRow {
  return {
    id: row.id,
    projectId: row.project_id,
    projectSlug: row.project_slug,
    projectName: row.project_name,
    jobKind: row.job_kind,
    target: row.target ?? {},
    cadenceIntervalSeconds: row.cadence_interval_seconds,
    nextRunAt: coerceDate(row.next_run_at),
    lastFiredAt: coerceNullableDate(row.last_fired_at),
    disabledAt: coerceNullableDate(row.disabled_at),
    consecutiveFailures: row.consecutive_failures,
    maxFailures: row.max_failures,
    lastStatus: row.last_status,
    lastFinishedAt: coerceNullableDate(row.last_finished_at),
    lastErrorCode: row.last_error_code,
  };
}

function toSchedulerRunScheduleOverviewRow(
  row: SchedulerRunScheduleOverviewDbRow,
): SchedulerRunScheduleOverviewRow {
  return {
    scheduleId: row.schedule_id,
    scheduleName: row.schedule_name,
    projectId: row.project_id,
    projectSlug: row.project_slug,
    projectName: row.project_name,
    taskId: row.task_id,
    taskNumber: row.task_number,
    taskTitle: row.task_title,
    taskStatus: row.task_status,
    cronExpr: row.cron_expr,
    timezone: row.timezone,
    overlapPolicy: row.overlap_policy,
    runnerId: row.runner_id,
    enabled: row.enabled,
    nextFireAt: coerceDate(row.next_fire_at),
    queueOnePending: row.queue_one_pending,
    queuedFireAt: coerceNullableDate(row.queued_fire_at),
    lastFiredAt: coerceNullableDate(row.last_fired_at),
    lastFireOutcome: row.last_fire_outcome,
    lastFireError: row.last_fire_error,
    lastRunId: row.last_run_id,
    lastRunStatus: row.last_run_status,
  };
}

function coerceDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function coerceNullableDate(value: Date | string | null): Date | null {
  if (value === null) return null;

  return coerceDate(value);
}
