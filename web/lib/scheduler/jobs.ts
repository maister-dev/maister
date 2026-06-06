import "server-only";

import type {
  SchedulerJobKind as DbSchedulerJobKind,
  SchedulerJobRunStatus,
} from "@/lib/db/schema";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import {
  schedulerBudgetLimits,
  type SchedulerBudgetKey,
} from "@/lib/scheduler/budgets";

export type SchedulerJobKind = DbSchedulerJobKind;

export const SCHEDULER_JOB_KINDS = [
  "system_sweep",
  "command",
  "agent_tick",
  "flow_run",
] as const satisfies readonly SchedulerJobKind[];

export type ClaimedSchedulerJob = {
  id: string;
  attemptId: string;
  jobKind: SchedulerJobKind;
  target: Record<string, unknown>;
  previousNextRunAt: Date;
  nextRunAt: Date;
  leaseExpiresAt: Date;
};

export type ClaimDueJobsInput = {
  now?: Date;
  leaseSeconds?: number;
  limit?: number;
  jobKind?: SchedulerJobKind;
  db?: SchedulerDb;
};

export type RecordJobAttemptResultInput = {
  jobId: string;
  attemptId: string;
  status: Extract<SchedulerJobRunStatus, "Succeeded" | "Failed" | "Skipped">;
  summary?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  now?: Date;
  db?: SchedulerDb;
};

export type ReapStuckSchedulerAttemptsInput = {
  now?: Date;
  db?: SchedulerDb;
};

export type EnsureDefaultSchedulerJobsInput = {
  now?: Date;
  db?: SchedulerDb;
};

export type ReapedSchedulerAttempt = {
  attemptId: string;
  jobId: string;
};

type ComputeNextRunAtInput = {
  previousNextRunAt: Date;
  now: Date;
  cadenceIntervalSeconds: number;
};

type SchedulerDb = {
  execute(query: SQL): Promise<QueryResult>;
};

type QueryResult = {
  rows?: unknown[];
};

type SchedulerRow = {
  id: string;
  attempt_id: string;
  job_kind: SchedulerJobKind;
  target: Record<string, unknown> | null;
  previous_next_run_at: Date | string;
  next_run_at: Date | string;
  lease_expires_at: Date | string;
};

type ReapedRow = {
  id: string;
  job_id: string;
};

type UpdatedAttemptRow = {
  id: string;
};

const log = pino({
  name: "scheduler-jobs",
  level: process.env.LOG_LEVEL ?? "info",
});

const DEFAULT_SYSTEM_SWEEP_JOB_ID = "system_sweep.default";
const DEFAULT_SYSTEM_SWEEP_CADENCE_SECONDS = 60;

export function isSchedulerJobKind(value: string): value is SchedulerJobKind {
  return SCHEDULER_JOB_KINDS.includes(value as SchedulerJobKind);
}

export function schedulerBudgetForKind(
  jobKind: SchedulerJobKind,
): SchedulerBudgetKey {
  switch (jobKind) {
    case "system_sweep":
      return "system_sweep";
    case "command":
      return "command";
    case "agent_tick":
      return "agent";
    case "flow_run":
      return "flow";
  }
}

export function computeNextRunAt(input: ComputeNextRunAtInput): Date {
  const intervalMs = input.cadenceIntervalSeconds * 1_000;

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new MaisterError(
      "CONFIG",
      `scheduler cadence_interval_seconds must be positive: ${input.cadenceIntervalSeconds}`,
    );
  }

  const elapsedMs = Math.max(
    0,
    input.now.getTime() - input.previousNextRunAt.getTime(),
  );
  const intervalsToAdvance = Math.floor(elapsedMs / intervalMs) + 1;

  return new Date(
    input.previousNextRunAt.getTime() + intervalsToAdvance * intervalMs,
  );
}

export async function ensureDefaultSchedulerJobs(
  input: EnsureDefaultSchedulerJobsInput = {},
): Promise<void> {
  const now = input.now ?? new Date();
  const db = input.db ?? (getDb() as unknown as SchedulerDb);

  await db.execute(sql`
    INSERT INTO scheduler_jobs (
      id,
      project_id,
      job_kind,
      target,
      cadence_interval_seconds,
      next_run_at,
      max_failures,
      created_at,
      updated_at
    )
    VALUES (
      ${DEFAULT_SYSTEM_SWEEP_JOB_ID},
      NULL,
      'system_sweep',
      '{}'::jsonb,
      ${DEFAULT_SYSTEM_SWEEP_CADENCE_SECONDS},
      ${now},
      3,
      ${now},
      ${now}
    )
    ON CONFLICT (id) DO NOTHING
  `);
}

export async function claimDueJobs(
  input: ClaimDueJobsInput = {},
): Promise<ClaimedSchedulerJob[]> {
  const now = input.now ?? new Date();
  const leaseSeconds = input.leaseSeconds ?? schedulerAttemptTimeoutSeconds();
  const limit = input.limit ?? 25;
  const budgets = schedulerBudgetLimits();

  if (limit <= 0) {
    throw new MaisterError("CONFIG", `scheduler claim limit must be positive`);
  }
  if (leaseSeconds <= 0) {
    throw new MaisterError(
      "CONFIG",
      `scheduler lease timeout must be positive: ${leaseSeconds}`,
    );
  }

  const db = input.db ?? (getDb() as unknown as SchedulerDb);
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000);
  const kindFilter = input.jobKind ?? null;
  const result = await db.execute(sql`
    WITH budget_limits (budget_key, max_concurrent) AS (
      VALUES
        ('system_sweep'::text, ${budgets.systemSweep}::int),
        ('command'::text, ${budgets.command}::int),
        ('agent'::text, ${budgets.agent}::int),
        ('flow'::text, ${budgets.flow}::int)
    ),
    active_budget AS (
      SELECT
        CASE r.job_kind
          WHEN 'system_sweep' THEN 'system_sweep'
          WHEN 'command' THEN 'command'
          WHEN 'agent_tick' THEN 'agent'
          WHEN 'flow_run' THEN 'flow'
        END AS budget_key,
        count(*)::int AS active_count
      FROM scheduler_job_runs r
      WHERE r.status IN ('Claimed', 'Running')
        AND r.lease_expires_at > ${now}
      GROUP BY 1
    ),
    due AS (
      SELECT
        j.*,
        CASE j.job_kind
          WHEN 'system_sweep' THEN 'system_sweep'
          WHEN 'command' THEN 'command'
          WHEN 'agent_tick' THEN 'agent'
          WHEN 'flow_run' THEN 'flow'
        END AS budget_key,
        bl.max_concurrent,
        coalesce(ab.active_count, 0) AS active_count
      FROM scheduler_jobs j
      JOIN budget_limits bl ON bl.budget_key = CASE j.job_kind
        WHEN 'system_sweep' THEN 'system_sweep'
        WHEN 'command' THEN 'command'
        WHEN 'agent_tick' THEN 'agent'
        WHEN 'flow_run' THEN 'flow'
      END
      LEFT JOIN active_budget ab ON ab.budget_key = bl.budget_key
      WHERE j.disabled_at IS NULL
        AND j.next_run_at <= ${now}
        AND (${kindFilter}::text IS NULL OR j.job_kind = ${kindFilter})
        AND NOT EXISTS (
          SELECT 1
          FROM scheduler_job_runs r
          WHERE r.job_id = j.id
            AND r.status IN ('Claimed', 'Running')
            AND r.lease_expires_at > ${now}
      )
      ORDER BY j.next_run_at ASC, j.id ASC
      FOR UPDATE SKIP LOCKED
    ),
    candidate AS (
      SELECT ranked.*
      FROM (
        SELECT
          due.*,
          row_number() OVER (
            PARTITION BY due.budget_key
            ORDER BY due.next_run_at ASC, due.id ASC
          ) AS budget_rank
        FROM due
      ) ranked
      WHERE ranked.budget_rank <= greatest(
        ranked.max_concurrent - ranked.active_count,
        0
      )
      ORDER BY ranked.next_run_at ASC, ranked.id ASC
      LIMIT ${limit}
    ),
    updated AS (
      UPDATE scheduler_jobs j
      SET
        last_fired_at = ${now},
        lease_expires_at = ${leaseExpiresAt},
        next_run_at = (
          candidate.next_run_at
          + (
            (
              floor(
                greatest(
                  extract(epoch from (${now}::timestamptz - candidate.next_run_at)),
                  0
                ) / candidate.cadence_interval_seconds
              )::int + 1
            )
            * candidate.cadence_interval_seconds
          ) * interval '1 second'
        ),
        updated_at = ${now}
      FROM candidate
      WHERE j.id = candidate.id
      RETURNING
        j.id,
        gen_random_uuid()::text AS attempt_id,
        j.job_kind,
        j.target,
        candidate.next_run_at AS previous_next_run_at,
        j.next_run_at,
        j.lease_expires_at
    ),
    inserted AS (
      INSERT INTO scheduler_job_runs (
        id,
        job_id,
        job_kind,
        status,
        claimed_at,
        lease_expires_at,
        created_at,
        updated_at
      )
      SELECT
        updated.attempt_id,
        updated.id,
        updated.job_kind,
        'Claimed',
        ${now},
        ${leaseExpiresAt},
        ${now},
        ${now}
      FROM updated
      RETURNING id
    )
    SELECT updated.*
    FROM updated
  `);

  const claimed = rowsOf<SchedulerRow>(result).map(toClaimedSchedulerJob);

  log.info(
    { claimedCount: claimed.length, jobKind: input.jobKind, now },
    "scheduler jobs claimed",
  );

  return claimed;
}

export async function recordJobAttemptStarted(input: {
  attemptId: string;
  now?: Date;
  db?: SchedulerDb;
}): Promise<void> {
  const now = input.now ?? new Date();
  const db = input.db ?? (getDb() as unknown as SchedulerDb);

  await db.execute(sql`
    UPDATE scheduler_job_runs
    SET status = 'Running', started_at = ${now}, updated_at = ${now}
    WHERE id = ${input.attemptId}
      AND status = 'Claimed'
  `);
}

export async function recordJobAttemptResult(
  input: RecordJobAttemptResultInput,
): Promise<void> {
  const now = input.now ?? new Date();
  const db = input.db ?? (getDb() as unknown as SchedulerDb);
  const summary = input.summary ?? {};
  const agentTickMaxFailures = schedulerAgentTickMaxFailures();

  const updatedAttempt = await db.execute(sql`
    UPDATE scheduler_job_runs
    SET
      status = ${input.status},
      finished_at = ${now},
      summary = ${summary},
      error_code = ${input.errorCode ?? null},
      error_message = ${input.errorMessage ?? null},
      updated_at = ${now}
    WHERE id = ${input.attemptId}
      AND job_id = ${input.jobId}
      AND status IN ('Claimed', 'Running')
    RETURNING id
  `);

  if (rowsOf<UpdatedAttemptRow>(updatedAttempt).length === 0) {
    log.warn(
      { jobId: input.jobId, attemptId: input.attemptId, status: input.status },
      "scheduler attempt result ignored after lease fencing",
    );

    return;
  }

  if (input.status === "Succeeded") {
    await db.execute(sql`
      UPDATE scheduler_jobs
      SET consecutive_failures = 0, lease_expires_at = NULL, updated_at = ${now}
      WHERE id = ${input.jobId}
    `);

    return;
  }

  await db.execute(sql`
    UPDATE scheduler_jobs
    SET
      consecutive_failures = consecutive_failures + 1,
      lease_expires_at = NULL,
      disabled_at = CASE
        WHEN consecutive_failures + 1 >= CASE
          WHEN job_kind = 'agent_tick' THEN ${agentTickMaxFailures}
          ELSE max_failures
        END THEN ${now}
        ELSE disabled_at
      END,
      updated_at = ${now}
    WHERE id = ${input.jobId}
  `);
}

export async function reapStuckSchedulerAttempts(
  input: ReapStuckSchedulerAttemptsInput = {},
): Promise<ReapedSchedulerAttempt[]> {
  const now = input.now ?? new Date();
  const db = input.db ?? (getDb() as unknown as SchedulerDb);
  const agentTickMaxFailures = schedulerAgentTickMaxFailures();
  const result = await db.execute(sql`
    UPDATE scheduler_job_runs
    SET
      status = 'Failed',
      finished_at = ${now},
      error_code = 'LEASE_EXPIRED',
      error_message = 'scheduler attempt lease expired',
      updated_at = ${now}
    WHERE status IN ('Claimed', 'Running')
      AND lease_expires_at <= ${now}
    RETURNING id, job_id
  `);
  const reaped = rowsOf<ReapedRow>(result).map((row) => ({
    attemptId: row.id,
    jobId: row.job_id,
  }));

  for (const attempt of reaped) {
    await db.execute(sql`
      UPDATE scheduler_jobs
      SET
        consecutive_failures = consecutive_failures + 1,
        lease_expires_at = NULL,
        disabled_at = CASE
          WHEN consecutive_failures + 1 >= CASE
            WHEN job_kind = 'agent_tick' THEN ${agentTickMaxFailures}
            ELSE max_failures
          END THEN ${now}
          ELSE disabled_at
        END,
        updated_at = ${now}
      WHERE id = ${attempt.jobId}
    `);
  }

  if (reaped.length > 0) {
    log.warn({ reapedCount: reaped.length }, "scheduler attempts reaped");
  }

  return reaped;
}

function schedulerAttemptTimeoutSeconds(): number {
  return Number(process.env.MAISTER_SCHEDULER_ATTEMPT_TIMEOUT_SECONDS ?? 300);
}

export function schedulerAgentTickMaxFailures(): number {
  const raw = process.env.MAISTER_SCHEDULER_AGENT_TICK_MAX_FAILURES;
  const parsed = raw ? Number.parseInt(raw, 10) : 3;

  if (!Number.isFinite(parsed) || parsed < 1) return 3;

  return parsed;
}

function rowsOf<T>(result: QueryResult): T[] {
  return (result.rows ?? []) as T[];
}

function toClaimedSchedulerJob(row: SchedulerRow): ClaimedSchedulerJob {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    jobKind: row.job_kind,
    target: row.target ?? {},
    previousNextRunAt: coerceDate(row.previous_next_run_at),
    nextRunAt: coerceDate(row.next_run_at),
    leaseExpiresAt: coerceDate(row.lease_expires_at),
  };
}

function coerceDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
