import type { Db } from "@/lib/execution-host/db";
import type { TaskAdmissionSnapshot } from "@/lib/tasks/qualification-types";

import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";

import { prepareTaskDeliveryAdmission } from "@/lib/tasks/qualification-admission";
import { prepareTaskLaunchFirstDispatch } from "@/lib/tasks/launch-first-dispatch";
import { takeSchedulerLock } from "@/lib/scheduler";
import { prepareTaskLaunchIntent } from "@/lib/tasks/launch-dispatch";
import { tasks, runs } from "@/lib/db/schema";

const receiptSchema = z.object({ intentId: z.string() }).passthrough();
const planSchema = z
  .object({ tasks: z.array(z.record(z.string(), z.unknown())) })
  .passthrough();

/** Existing lifecycle tests explicitly bind real queued intents; this never starts a model or manufactures a Run. */
export async function bindQueuedDelegationResponse(
  db: Db,
  response: NextResponse,
): Promise<NextResponse> {
  if (response.status !== 202) return response;
  const body: unknown = await response.clone().json();
  const one = receiptSchema.safeParse(body);
  const bind = async (
    entry: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const parsed = receiptSchema.safeParse(entry);

    if (!parsed.success) return entry;
    const prepared = await prepareTaskLaunchIntent(db, parsed.data.intentId);

    if (!prepared.runId)
      return { ...entry, runId: null, childRunId: null, status: "Queued" };
    const [run] = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, prepared.runId));

    if (!run) throw new Error("Prepared delegation intent has no actual Run");

    return {
      ...entry,
      runId: prepared.runId,
      childRunId: prepared.runId,
      status: run.status,
    };
  };

  if (one.success)
    return NextResponse.json(await bind(one.data), {
      status: response.status,
      headers: response.headers,
    });
  const plan = planSchema.safeParse(body);

  if (!plan.success) return response;
  const entries: Array<Record<string, unknown>> = [];

  for (const entry of plan.data.tasks) entries.push(await bind(entry));

  return NextResponse.json(
    { ...plan.data, tasks: entries },
    { status: response.status, headers: response.headers },
  );
}

/** Lifecycle simulations still commit the real immutable first-dispatch authority before changing Run state. */
export async function commitDelegatedDispatchForRunChecks(
  db: Db,
  runId: string,
): Promise<void> {
  const dispatch = await prepareTaskLaunchFirstDispatch(db, runId);

  if (!dispatch)
    throw new Error("Expected accepted delegated dispatch authority");
  await db.transaction(async (tx) => {
    await takeSchedulerLock(tx);
    await dispatch.apply(tx as unknown as Db);
  });
}

/** Dependency-consumer tests drive the existing durable worker boundary once after event acceptance. */
export async function bindPendingPlanIntentsForRunChecks(
  db: Db,
): Promise<void> {
  const pending = await db.execute<{ id: string }>(
    sql`SELECT id FROM task_launch_intents WHERE state IN ('queued','preparing') AND settings_snapshot->'serverExecution'->>'kind'='execution_plan' ORDER BY accepted_at,id LIMIT 100`,
  );

  for (const intent of pending.rows)
    await prepareTaskLaunchIntent(db, intent.id);
}

/** Historical child event fixtures derive their admission from the real parent proof at INSERT. */
export async function historicalChildFixtureAdmission(
  db: Db,
  projectId: string,
  taskId: string | null,
): Promise<TaskAdmissionSnapshot | null> {
  if (!taskId) return null;
  const [task] = await db
    .select({ mode: tasks.qualificationMode })
    .from(tasks)
    .where(eq(tasks.id, taskId));

  if (task?.mode !== "execution_child") return null;
  const prepared = await prepareTaskDeliveryAdmission(db, {
    projectId,
    taskId,
  });

  return db.transaction((tx) => prepared.apply(tx as unknown as Db));
}
