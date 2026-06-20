import "server-only";

import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import {
  schedulerAgentTickMaxFailures,
  type SchedulerJobKind,
} from "@/lib/scheduler/jobs";
import { normalizeSchedulerTargetDraft } from "@/lib/scheduler/job-targets";

type AdminDb = {
  execute(query: SQL): Promise<{ rows?: unknown[] }>;
};

export type CreateSchedulerJobInput = {
  id?: string;
  jobKind: SchedulerJobKind;
  target?: Record<string, unknown>;
  cadenceIntervalSeconds: number;
  maxFailures?: number;
  nextRunAt?: Date;
  projectId?: string | null;
};

export type UpdateSchedulerJobInput = {
  target?: Record<string, unknown>;
  cadenceIntervalSeconds?: number;
  maxFailures?: number;
  nextRunAt?: Date;
  enabled?: boolean;
};

const DEFAULT_MAX_FAILURES = 3;

const log = pino({
  name: "scheduler-job-admin",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function createSchedulerJob(
  input: CreateSchedulerJobInput,
  db?: AdminDb,
): Promise<{ id: string }> {
  const database = db ?? (getDb() as unknown as AdminDb);
  const target = normalizeAdminSchedulerTarget(
    input.jobKind,
    input.target ?? {},
  );

  if (input.cadenceIntervalSeconds <= 0) {
    throw new MaisterError(
      "CONFIG",
      `scheduler cadence_interval_seconds must be positive: ${input.cadenceIntervalSeconds}`,
    );
  }

  const id = input.id ?? randomUUID();
  const maxFailures = input.maxFailures ?? defaultMaxFailures(input.jobKind);
  const nextRunAt = input.nextRunAt ?? new Date();
  const result = await database.execute(sql`
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
      ${id},
      ${input.projectId ?? null},
      ${input.jobKind},
      ${JSON.stringify(target)}::jsonb,
      ${input.cadenceIntervalSeconds},
      ${nextRunAt},
      ${maxFailures},
      now(),
      now()
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `);

  if (rowsOf<{ id: string }>(result).length === 0) {
    throw new MaisterError("CONFLICT", `scheduler job already exists: ${id}`);
  }

  log.info({ id, jobKind: input.jobKind }, "scheduler job created");

  return { id };
}

export async function updateSchedulerJob(
  jobId: string,
  input: UpdateSchedulerJobInput,
  db?: AdminDb,
): Promise<void> {
  const database = db ?? (getDb() as unknown as AdminDb);
  const existing = await database.execute(sql`
    SELECT job_kind FROM scheduler_jobs WHERE id = ${jobId} LIMIT 1
  `);
  const row = rowsOf<{ job_kind: SchedulerJobKind }>(existing)[0];

  if (!row) {
    throw new MaisterError("PRECONDITION", `scheduler job not found: ${jobId}`);
  }
  const target =
    input.target === undefined
      ? undefined
      : normalizeAdminSchedulerTarget(row.job_kind, input.target);

  if (
    input.cadenceIntervalSeconds !== undefined &&
    input.cadenceIntervalSeconds <= 0
  ) {
    throw new MaisterError(
      "CONFIG",
      `scheduler cadence_interval_seconds must be positive: ${input.cadenceIntervalSeconds}`,
    );
  }

  const sets: SQL[] = [sql`updated_at = now()`];

  if (target !== undefined) {
    sets.push(sql`target = ${JSON.stringify(target)}::jsonb`);
  }
  if (input.cadenceIntervalSeconds !== undefined) {
    sets.push(sql`cadence_interval_seconds = ${input.cadenceIntervalSeconds}`);
  }
  if (input.maxFailures !== undefined) {
    sets.push(sql`max_failures = ${input.maxFailures}`);
  }
  if (input.nextRunAt !== undefined) {
    sets.push(sql`next_run_at = ${input.nextRunAt}`);
  }
  if (input.enabled === true) {
    sets.push(sql`disabled_at = NULL`);
    sets.push(sql`consecutive_failures = 0`);
  }
  if (input.enabled === false) {
    sets.push(sql`disabled_at = now()`);
  }

  const result = await database.execute(sql`
    UPDATE scheduler_jobs
    SET ${sql.join(sets, sql`, `)}
    WHERE id = ${jobId}
    RETURNING id
  `);

  if (rowsOf<{ id: string }>(result).length === 0) {
    throw new MaisterError("PRECONDITION", `scheduler job not found: ${jobId}`);
  }

  log.info({ jobId }, "scheduler job updated");
}

export async function deleteSchedulerJob(
  jobId: string,
  db?: AdminDb,
): Promise<void> {
  const database = db ?? (getDb() as unknown as AdminDb);
  const result = await database.execute(sql`
    DELETE FROM scheduler_jobs WHERE id = ${jobId} RETURNING id
  `);

  if (rowsOf<{ id: string }>(result).length === 0) {
    throw new MaisterError("PRECONDITION", `scheduler job not found: ${jobId}`);
  }

  log.info({ jobId }, "scheduler job deleted");
}

function defaultMaxFailures(jobKind: SchedulerJobKind): number {
  return jobKind === "agent_tick"
    ? schedulerAgentTickMaxFailures()
    : DEFAULT_MAX_FAILURES;
}

function normalizeAdminSchedulerTarget(
  jobKind: SchedulerJobKind | undefined,
  target: Record<string, unknown>,
): Record<string, unknown> {
  if (jobKind === undefined) {
    throw new MaisterError("PRECONDITION", "scheduler job kind is unknown");
  }

  try {
    return normalizeSchedulerTargetDraft({ draft: target, jobKind });
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        jobKind,
        targetKeys: Object.keys(target).sort(),
      },
      "[FIX:scheduler-target-validation] rejected invalid scheduler target",
    );

    throw new MaisterError(
      "CONFIG",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function rowsOf<T>(result: { rows?: unknown[] }): T[] {
  return (result.rows ?? []) as T[];
}
