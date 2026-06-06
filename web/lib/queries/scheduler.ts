import "server-only";

import type { SchedulerJobKind, SchedulerJobRunStatus } from "@/lib/db/schema";

import { sql, type SQL } from "drizzle-orm";

import { getDb } from "@/lib/db/client";

export type SchedulerStatusRow = {
  id: string;
  projectId: string | null;
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

type SchedulerQueryDb = {
  execute(query: SQL): Promise<{ rows?: unknown[] }>;
};

type SchedulerStatusDbRow = {
  id: string;
  project_id: string | null;
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

function toSchedulerStatusRow(row: SchedulerStatusDbRow): SchedulerStatusRow {
  return {
    id: row.id,
    projectId: row.project_id,
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

function coerceDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function coerceNullableDate(value: Date | string | null): Date | null {
  if (value === null) return null;

  return coerceDate(value);
}
