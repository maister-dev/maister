import "server-only";

import type {
  RunScheduleFireOutcome,
  RunScheduleOverlapPolicy,
  RunStatus,
} from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, asc, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

const { runSchedules, runs, tasks } = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

export type ScheduleDTO = {
  id: string;
  name: string;
  taskId: string;
  taskTitle: string | null;
  cronExpr: string;
  timezone: string;
  overlapPolicy: RunScheduleOverlapPolicy;
  runnerId: string | null;
  enabled: boolean;
  nextFireAt: string;
  queueOnePending: boolean;
  queuedFireAt: string | null;
  lastFiredAt: string | null;
  lastFireOutcome: RunScheduleFireOutcome | null;
  lastFireError: string | null;
  lastRunId: string | null;
  lastRunStatus: RunStatus | null;
  createdAt: string;
  updatedAt: string;
};

const dtoSelection = {
  id: runSchedules.id,
  name: runSchedules.name,
  taskId: runSchedules.taskId,
  taskTitle: tasks.title,
  cronExpr: runSchedules.cronExpr,
  timezone: runSchedules.timezone,
  overlapPolicy: runSchedules.overlapPolicy,
  runnerId: runSchedules.runnerId,
  enabled: runSchedules.enabled,
  nextFireAt: runSchedules.nextFireAt,
  queueOnePending: runSchedules.queueOnePending,
  queuedFireAt: runSchedules.queuedFireAt,
  lastFiredAt: runSchedules.lastFiredAt,
  lastFireOutcome: runSchedules.lastFireOutcome,
  lastFireError: runSchedules.lastFireError,
  lastRunId: runSchedules.lastRunId,
  lastRunStatus: runs.status,
  createdAt: runSchedules.createdAt,
  updatedAt: runSchedules.updatedAt,
} as const;

type DtoRow = {
  id: string;
  name: string;
  taskId: string;
  taskTitle: string | null;
  cronExpr: string;
  timezone: string;
  overlapPolicy: RunScheduleOverlapPolicy;
  runnerId: string | null;
  enabled: boolean;
  nextFireAt: Date;
  queueOnePending: boolean;
  queuedFireAt: Date | null;
  lastFiredAt: Date | null;
  lastFireOutcome: RunScheduleFireOutcome | null;
  lastFireError: string | null;
  lastRunId: string | null;
  lastRunStatus: RunStatus | null;
  createdAt: Date;
  updatedAt: Date;
};

function toScheduleDTO(row: DtoRow): ScheduleDTO {
  return {
    id: row.id,
    name: row.name,
    taskId: row.taskId,
    taskTitle: row.taskTitle,
    cronExpr: row.cronExpr,
    timezone: row.timezone,
    overlapPolicy: row.overlapPolicy,
    runnerId: row.runnerId,
    enabled: row.enabled,
    nextFireAt: row.nextFireAt.toISOString(),
    queueOnePending: row.queueOnePending,
    queuedFireAt: row.queuedFireAt?.toISOString() ?? null,
    lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
    lastFireOutcome: row.lastFireOutcome,
    lastFireError: row.lastFireError,
    lastRunId: row.lastRunId,
    lastRunStatus: row.lastRunStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listProjectSchedules(
  projectId: string,
): Promise<ScheduleDTO[]> {
  const rows = await db()
    .select(dtoSelection)
    .from(runSchedules)
    .leftJoin(tasks, eq(tasks.id, runSchedules.taskId))
    .leftJoin(runs, eq(runs.id, runSchedules.lastRunId))
    .where(eq(runSchedules.projectId, projectId))
    .orderBy(asc(runSchedules.createdAt));

  return rows.map(toScheduleDTO);
}

export async function getProjectScheduleDTO(
  projectId: string,
  scheduleId: string,
): Promise<ScheduleDTO | null> {
  const rows = await db()
    .select(dtoSelection)
    .from(runSchedules)
    .leftJoin(tasks, eq(tasks.id, runSchedules.taskId))
    .leftJoin(runs, eq(runs.id, runSchedules.lastRunId))
    .where(
      and(
        eq(runSchedules.projectId, projectId),
        eq(runSchedules.id, scheduleId),
      ),
    );
  const row = rows[0];

  return row ? toScheduleDTO(row) : null;
}
