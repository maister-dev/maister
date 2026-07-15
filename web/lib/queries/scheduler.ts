import "server-only";

import type {
  RunScheduleFireOutcome,
  RunScheduleOverlapPolicy,
  RunStatus,
  SchedulerJobKind,
  SchedulerJobRunStatus,
} from "@/lib/db/schema";
import type {
  BrainIndexJobReason,
  BrainIndexJobStatus,
  BrainIndexQueueData,
  BrainIndexQueueDataRow,
  SchedulerClockStatus,
  SchedulerRunScheduleOverviewDataRow,
} from "@/types/scheduler";

import { sql, type SQL } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { readSchedulerClockStatus } from "@/lib/scheduler/timer-config";

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

export type SchedulerScheduledLaunchOverviewRow = {
  scheduledLaunchId: string;
  projectSlug: string;
  projectName: string;
  taskKey: string;
  taskNumber: number;
  taskTitle: string;
  state: string;
  nextAttemptAt: Date | null;
  attemptCount: number;
  latestOutcome: string | null;
  errorCode: string | null;
  updatedAt: Date;
};

export type BrainIndexQueueRow = BrainIndexQueueDataRow;

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

type SchedulerScheduledLaunchOverviewDbRow = {
  scheduled_launch_id: string;
  project_slug: string;
  project_name: string;
  task_key: string;
  task_number: number;
  task_title: string;
  state: string;
  next_attempt_at: Date | string | null;
  attempt_count: number;
  latest_outcome: string | null;
  error_code: string | null;
  updated_at: Date | string;
};

type BrainIndexQueueDbRow = {
  created_at: Date | string;
  id: string;
  progress: number;
  project_id: string;
  project_name: string;
  project_slug: string;
  reason: BrainIndexJobReason;
  resumable_cursor: unknown;
  source_id: string | null;
  source_last_error: unknown;
  source_last_indexed_at: Date | string | null;
  source_path: string | null;
  status: BrainIndexJobStatus;
};

type BrainIndexQueueSummaryDbRow = {
  completed: number | string | null;
  failed: number | string | null;
  queued: number | string | null;
  running: number | string | null;
  total: number | string | null;
};

type TableExistsDbRow = {
  applied: boolean | null;
};

export function getSchedulerClockStatus(): SchedulerClockStatus {
  return readSchedulerClockStatus();
}

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

export async function listSchedulerScheduledLaunchOverviewRows(
  args: {
    limit?: number;
    db?: SchedulerQueryDb;
  } = {},
): Promise<SchedulerScheduledLaunchOverviewRow[]> {
  const db = args.db ?? (getDb() as unknown as SchedulerQueryDb);
  const limit = args.limit ?? 100;
  const result = await db.execute(sql`
    SELECT
      l.id AS scheduled_launch_id,
      p.slug AS project_slug,
      p.name AS project_name,
      l.task_key,
      l.task_number,
      l.task_title,
      l.state,
      l.next_attempt_at,
      l.attempt_count,
      l.latest_outcome,
      l.error_code,
      l.updated_at
    FROM scheduled_task_launches l
    INNER JOIN projects p ON p.id = l.project_id
    WHERE p.archived_at IS NULL
    ORDER BY
      (l.next_attempt_at IS NULL) ASC,
      l.next_attempt_at ASC NULLS LAST,
      l.updated_at DESC,
      l.id ASC
    LIMIT ${limit}
  `);

  return (result.rows ?? []).map((row) => {
    const launch = row as SchedulerScheduledLaunchOverviewDbRow;

    return {
      scheduledLaunchId: launch.scheduled_launch_id,
      projectSlug: launch.project_slug,
      projectName: launch.project_name,
      taskKey: launch.task_key,
      taskNumber: launch.task_number,
      taskTitle: launch.task_title,
      state: launch.state,
      nextAttemptAt: coerceNullableDate(launch.next_attempt_at),
      attemptCount: launch.attempt_count,
      latestOutcome: launch.latest_outcome,
      errorCode: launch.error_code,
      updatedAt: coerceDate(launch.updated_at),
    };
  });
}

export async function listBrainIndexQueueRows(
  args: {
    limit?: number;
    db?: SchedulerQueryDb;
  } = {},
): Promise<BrainIndexQueueData> {
  const db = args.db ?? (getDb() as unknown as SchedulerQueryDb);
  const limit = args.limit ?? 50;
  const schemaApplied = await hasBrainIndexQueueSchema(db);

  if (!schemaApplied) {
    return {
      rows: [],
      schemaApplied: false,
      summary: emptyBrainIndexQueueSummary(),
    };
  }

  const [summaryResult, rowsResult] = await Promise.all([
    db.execute(sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'queued')::int AS queued,
        count(*) FILTER (WHERE status = 'running')::int AS running,
        count(*) FILTER (WHERE status = 'failed')::int AS failed,
        count(*) FILTER (WHERE status = 'completed')::int AS completed
      FROM brain_index_jobs
    `),
    db.execute(sql`
      SELECT
        j.id,
        j.project_id,
        p.slug AS project_slug,
        p.name AS project_name,
        j.source_id,
        s.path AS source_path,
        s.last_indexed_at AS source_last_indexed_at,
        s.last_error AS source_last_error,
        j.reason,
        j.status,
        j.progress,
        j.resumable_cursor,
        j.created_at
      FROM brain_index_jobs j
      INNER JOIN projects p ON p.id = j.project_id
      LEFT JOIN brain_sources s ON s.id = j.source_id
      ORDER BY
        CASE j.status
          WHEN 'running' THEN 0
          WHEN 'queued' THEN 1
          WHEN 'failed' THEN 2
          ELSE 3
        END ASC,
        j.created_at DESC,
        j.id ASC
      LIMIT ${limit}
    `),
  ]);

  const summaryRow = (summaryResult.rows?.[0] ??
    {}) as BrainIndexQueueSummaryDbRow;

  return {
    rows: (rowsResult.rows ?? []).map((row) =>
      toBrainIndexQueueRow(row as BrainIndexQueueDbRow),
    ),
    schemaApplied: true,
    summary: {
      completed: coerceCount(summaryRow.completed),
      failed: coerceCount(summaryRow.failed),
      queued: coerceCount(summaryRow.queued),
      running: coerceCount(summaryRow.running),
      total: coerceCount(summaryRow.total),
    },
  };
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

function toBrainIndexQueueRow(row: BrainIndexQueueDbRow): BrainIndexQueueRow {
  return {
    createdAt: coerceDate(row.created_at),
    id: row.id,
    progress: row.progress,
    projectId: row.project_id,
    projectName: row.project_name,
    projectSlug: row.project_slug,
    reason: row.reason,
    resumableCursor: coerceRecord(row.resumable_cursor),
    sourceId: row.source_id,
    sourceLastError: coerceRecord(row.source_last_error),
    sourceLastIndexedAt: coerceNullableDate(row.source_last_indexed_at),
    sourcePath: row.source_path,
    status: row.status,
  };
}

async function hasBrainIndexQueueSchema(
  db: SchedulerQueryDb,
): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT (
      to_regclass('public.brain_index_jobs') IS NOT NULL
      AND to_regclass('public.brain_sources') IS NOT NULL
    ) AS applied
  `);
  const row = result.rows?.[0] as TableExistsDbRow | undefined;

  return row?.applied === true;
}

function emptyBrainIndexQueueSummary(): BrainIndexQueueData["summary"] {
  return { completed: 0, failed: 0, queued: 0, running: 0, total: 0 };
}

function coerceRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return null;
  if (typeof value !== "object") return null;

  return value as Record<string, unknown>;
}

function coerceCount(value: number | string | null | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);

    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function coerceDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function coerceNullableDate(value: Date | string | null): Date | null {
  if (value === null) return null;

  return coerceDate(value);
}
