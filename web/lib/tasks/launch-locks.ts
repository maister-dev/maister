import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { asc, eq, sql } from "drizzle-orm";

import { runs, taskLaunchIntents, executionAssignments } from "@/lib/db/schema";

/** Capacity lock, when needed, precedes this reservation lock; run/intent/task row locks follow it. */
export async function lockTaskLaunchReservation(
  db: Db,
  taskId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(1818326383, hashtext(${taskId}))`,
  );
}

/** Caller owns the task reservation. Lock run and assignment rows before taking the intent row. */
export async function lockTaskLaunchBoundRun(
  db: Db,
  intentId: string,
): Promise<void> {
  const [navigation] = await db
    .select({ runId: taskLaunchIntents.runId })
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, intentId));

  if (!navigation?.runId) return;
  await db
    .select()
    .from(runs)
    .where(eq(runs.id, navigation.runId))
    .for("update");
  await db
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.runId, navigation.runId))
    .orderBy(asc(executionAssignments.id))
    .for("update");
}
