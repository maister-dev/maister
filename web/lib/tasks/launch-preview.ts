import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TaskLaunchRequest } from "./launch-schema";
import type { TaskLaunchReceipt } from "./launch-types";
import type { TaskQualificationSummary } from "./qualification-queries";
import type { TaskLaunchHostSelection } from "@/lib/execution-host/project-preference";

import { and, eq, inArray } from "drizzle-orm";

import { taskLaunchReceipt } from "./launch-receipt";
import { taskLaunchSettingsPreview } from "./launch-resolution";
import { getTaskQualificationSummaries } from "./qualification-queries";

import { runs, taskLaunchIntents } from "@/lib/db/schema";
import { bindTaskLaunchPlacementToken } from "@/lib/execution-host/project-preference";

/** Called after project launch authorization; exposes no input or principal credentials. */
export async function taskLaunchPreview(
  db: Db,
  taskId: string,
  selection: Partial<TaskLaunchRequest>,
): Promise<{
  settingsToken: string;
  qualification: TaskQualificationSummary | null;
  activeLaunch: TaskLaunchReceipt | null;
  executionHostSelection?: TaskLaunchHostSelection;
}> {
  const [{ metadataToken, placement }, state] = await Promise.all([
    taskLaunchSettingsPreview(db, taskId, selection),
    taskLaunchPreviewState(db, taskId),
  ]);

  return {
    settingsToken: bindTaskLaunchPlacementToken(metadataToken, placement),
    ...(placement ? { executionHostSelection: placement.selection } : {}),
    ...state,
  };
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
