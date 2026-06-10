import "server-only";

import type { RunSchedule, RunScheduleOverlapPolicy } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { nextFireAt, validateCronExpression } from "@/lib/run-schedules/cron";

const { platformAcpRunners, runSchedules, tasks } = schema;

const log = pino({
  name: "run-schedules",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

export type CreateScheduleInput = {
  projectId: string;
  taskId: string;
  name: string;
  cronExpr: string;
  timezone: string;
  overlapPolicy?: RunScheduleOverlapPolicy;
  runnerId?: string | null;
  enabled?: boolean;
  actorUserId: string | null;
};

export type UpdateSchedulePatch = {
  name?: string;
  cronExpr?: string;
  timezone?: string;
  overlapPolicy?: RunScheduleOverlapPolicy;
  runnerId?: string | null;
  enabled?: boolean;
};

export type ScheduleActor = {
  actorUserId: string | null;
};

export async function createSchedule(
  input: CreateScheduleInput,
): Promise<RunSchedule> {
  validateCronExpression(input.cronExpr, input.timezone);

  const taskRows = await db()
    .select({ projectId: tasks.projectId, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, input.taskId));
  const task = taskRows[0];

  if (!task || task.projectId !== input.projectId) {
    throw new MaisterError(
      "PRECONDITION",
      `Task not found in project: ${input.taskId}`,
    );
  }
  // Terminal tasks can never fire — the launch gate refuses target_terminal,
  // so a schedule on one would only ever record skipped_target_terminal.
  if (task.status === "Done" || task.status === "Abandoned") {
    throw new MaisterError(
      "PRECONDITION",
      `Cannot schedule a terminal task (${task.status}): ${input.taskId}`,
    );
  }

  if (input.runnerId != null) {
    const runnerRows = await db()
      .select({ id: platformAcpRunners.id })
      .from(platformAcpRunners)
      .where(eq(platformAcpRunners.id, input.runnerId));

    if (runnerRows.length === 0) {
      throw new MaisterError("CONFIG", `Unknown runner: ${input.runnerId}`);
    }
  }

  const scheduleId = crypto.randomUUID();
  const firstFireAt = nextFireAt(input.cronExpr, input.timezone, new Date());

  const inserted = await db().transaction(async (tx) => {
    const rows = await tx
      .insert(runSchedules)
      .values({
        id: scheduleId,
        projectId: input.projectId,
        taskId: input.taskId,
        name: input.name,
        cronExpr: input.cronExpr,
        timezone: input.timezone,
        overlapPolicy: input.overlapPolicy ?? "skip",
        runnerId: input.runnerId ?? null,
        enabled: input.enabled ?? true,
        nextFireAt: firstFireAt,
        createdByUserId: input.actorUserId,
      })
      .returning();

    return rows[0];
  });

  log.info(
    {
      scheduleId,
      projectId: input.projectId,
      action: "create",
      actorUserId: input.actorUserId,
    },
    "run schedule created",
  );

  return inserted;
}

export async function updateSchedule(
  projectId: string,
  scheduleId: string,
  patch: UpdateSchedulePatch,
  actor: ScheduleActor,
): Promise<RunSchedule | null> {
  const updated = await db().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(runSchedules)
      .where(
        and(
          eq(runSchedules.id, scheduleId),
          eq(runSchedules.projectId, projectId),
        ),
      );
    const current = rows[0];

    if (!current) return null;

    const effectiveCronExpr = patch.cronExpr ?? current.cronExpr;
    const effectiveTimezone = patch.timezone ?? current.timezone;

    if (patch.cronExpr !== undefined || patch.timezone !== undefined) {
      validateCronExpression(effectiveCronExpr, effectiveTimezone);
    }

    if (patch.runnerId !== undefined && patch.runnerId !== null) {
      const runnerRows = await tx
        .select({ id: platformAcpRunners.id })
        .from(platformAcpRunners)
        .where(eq(platformAcpRunners.id, patch.runnerId));

      if (runnerRows.length === 0) {
        throw new MaisterError("CONFIG", `Unknown runner: ${patch.runnerId}`);
      }
    }

    const values: Partial<typeof runSchedules.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (patch.name !== undefined) values.name = patch.name;
    if (patch.cronExpr !== undefined) values.cronExpr = patch.cronExpr;
    if (patch.timezone !== undefined) values.timezone = patch.timezone;
    if (patch.overlapPolicy !== undefined) {
      values.overlapPolicy = patch.overlapPolicy;
    }
    if (patch.runnerId !== undefined) values.runnerId = patch.runnerId;
    if (patch.enabled !== undefined) values.enabled = patch.enabled;

    // Re-arm only on the Paused→Active transition — a redundant enabled:true
    // (e.g. bundled with a rename) must not push a due fire forward.
    const recompute =
      patch.cronExpr !== undefined ||
      patch.timezone !== undefined ||
      (patch.enabled === true && !current.enabled);

    if (recompute) {
      values.nextFireAt = nextFireAt(
        effectiveCronExpr,
        effectiveTimezone,
        new Date(),
      );
    }

    if (patch.enabled === false) {
      values.queueOnePending = false;
      values.queuedFireAt = null;
    }

    const updatedRows = await tx
      .update(runSchedules)
      .set(values)
      .where(
        and(
          eq(runSchedules.id, scheduleId),
          eq(runSchedules.projectId, projectId),
        ),
      )
      .returning();

    return updatedRows[0] ?? null;
  });

  if (updated) {
    log.info(
      {
        scheduleId,
        projectId,
        action: "update",
        actorUserId: actor.actorUserId,
      },
      "run schedule updated",
    );
  }

  return updated;
}

export async function deleteSchedule(
  projectId: string,
  scheduleId: string,
  actor: ScheduleActor,
): Promise<boolean> {
  const rows = await db()
    .delete(runSchedules)
    .where(
      and(
        eq(runSchedules.id, scheduleId),
        eq(runSchedules.projectId, projectId),
      ),
    )
    .returning({ id: runSchedules.id });
  const deleted = rows.length > 0;

  if (deleted) {
    log.info(
      {
        scheduleId,
        projectId,
        action: "delete",
        actorUserId: actor.actorUserId,
      },
      "run schedule deleted",
    );
  }

  return deleted;
}

export async function getScheduleForProject(
  projectId: string,
  scheduleId: string,
): Promise<RunSchedule | null> {
  const rows = await db()
    .select()
    .from(runSchedules)
    .where(
      and(
        eq(runSchedules.id, scheduleId),
        eq(runSchedules.projectId, projectId),
      ),
    );

  return rows[0] ?? null;
}
