import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TaskLaunchRequest } from "./launch-schema";
import type { TaskLaunchReceipt } from "./launch-types";
import type { TaskQualificationSummary } from "./qualification-queries";

import { and, eq, inArray } from "drizzle-orm";

import { taskLaunchReceipt } from "./launch-receipt";
import { taskLaunchSettingsToken } from "./launch-resolution";
import { getTaskQualificationSummaries } from "./qualification-queries";

import { runs, taskLaunchIntents } from "@/lib/db/schema";

/** Called after project launch authorization; exposes no input or principal credentials. */
export async function taskLaunchPreview(
  db: Db,
  taskId: string,
  selection: Partial<TaskLaunchRequest>,
): Promise<{
  settingsToken: string;
  qualification: TaskQualificationSummary | null;
  activeLaunch: TaskLaunchReceipt | null;
}> {
  const [settingsToken, state] = await Promise.all([
    taskLaunchSettingsToken(db, taskId, selection),
    taskLaunchPreviewState(db, taskId),
  ]);

  return { settingsToken, ...state };
}

/** Shared read projection for a token already resolved by the selected target's authority. */
export async function taskLaunchPreviewState(
  db: Db,
  taskId: string,
): Promise<{
  qualification: TaskQualificationSummary | null;
  activeLaunch: TaskLaunchReceipt | null;
}> {
  const [qualifications, intents] = await Promise.all([
    getTaskQualificationSummaries(db, [taskId]),
    db
      .select()
      .from(taskLaunchIntents)
      .where(
        and(
          eq(taskLaunchIntents.taskId, taskId),
          eq(taskLaunchIntents.reservationLane, "ordinary"),
          inArray(taskLaunchIntents.state, [
            "queued",
            "preparing",
            "run_bound",
            "held",
          ]),
        ),
      )
      .limit(1),
  ]);
  const intent = intents[0];
  const [run] = intent?.runId
    ? await db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, intent.runId))
    : [];

  return {
    qualification: qualifications.get(taskId) ?? null,
    activeLaunch: intent
      ? {
          ...taskLaunchReceipt(intent),
          ...(run ? { runStatus: run.status } : {}),
        }
      : null,
  };
}
