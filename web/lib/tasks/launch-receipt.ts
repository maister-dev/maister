import "server-only";

import type {
  TaskLaunchReceipt,
  TaskLaunchSettingsSnapshot,
} from "./launch-types";
import type { taskLaunchIntents } from "@/lib/db/schema";
import type { TaskLaunchHostSelection } from "@/lib/execution-host/project-preference";
import type { Db } from "@/lib/execution-host/db";

import { and, eq } from "drizzle-orm";

import { retryDigest } from "@/lib/agents/retry-guards";
import { executionAssignments, executionHosts, runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

export function taskLaunchHostSelection(
  row: Pick<
    typeof taskLaunchIntents.$inferSelect,
    | "requestedExecutionHostId"
    | "effectiveExecutionHostId"
    | "executionHostEligibilityRevision"
    | "executionHostProvenance"
  >,
): TaskLaunchHostSelection | null {
  if (row.effectiveExecutionHostId === null) return null;
  if (!row.executionHostEligibilityRevision || !row.executionHostProvenance)
    throw new MaisterError(
      "PRECONDITION",
      "Retained launch host selection is incomplete",
    );

  return {
    requestedExecutionHostId: row.requestedExecutionHostId,
    effectiveExecutionHostId: row.effectiveExecutionHostId,
    provenance: row.executionHostProvenance,
    eligibilityRevision: row.executionHostEligibilityRevision,
  };
}

export function taskLaunchSettingsDigest(
  settings: TaskLaunchSettingsSnapshot,
  selection: TaskLaunchHostSelection | null,
): string {
  return selection
    ? retryDigest({ settings, executionHostSelection: selection })
    : retryDigest(settings);
}

export function taskLaunchReceipt(
  row: typeof taskLaunchIntents.$inferSelect,
): TaskLaunchReceipt {
  const settings = row.settingsSnapshot;
  const executionHostSelection = taskLaunchHostSelection(row);

  return {
    schemaVersion: 1,
    intentId: row.id,
    taskId: row.taskId,
    state: row.state,
    stateVersion: row.stateVersion,
    basis: row.basis.kind,
    acceptedAt: row.acceptedAt.toISOString(),
    taskRevision: row.taskRevision,
    inputRevision: row.inputRevision,
    settingsDigest: row.settingsDigest,
    runId: row.runId,
    reason: row.reason,
    ...(executionHostSelection ? { executionHostSelection } : {}),
    ...(row.replacesIntentId
      ? { supersedesIntentId: row.replacesIntentId }
      : {}),
    snapshot: {
      kind: settings.kind,
      workspace: settings.workspace,
      flowId: settings.flowId,
      flowRevisionId: settings.flowRevisionId,
      agentId: settings.agentId,
      runnerIds: [...new Set(settings.sessions.map((slot) => slot.runnerId))],
      sessions: settings.sessions.map((slot) => ({
        sessionName: slot.sessionName,
        runnerId: slot.runnerId,
        capabilityAgent: slot.runnerSnapshot.capabilityAgent,
        model: slot.runnerSnapshot.model,
      })),
      flowRefId: settings.flowRefId,
      deliveryPolicy: settings.deliveryPolicy,
      baseCommit: settings.baseCommit,
      targetBranch: settings.targetBranch,
      promotionMode: settings.promotionMode,
      autoPromote: settings.autoPromote,
    },
    ...(row.terminalOutcome ? { terminalOutcome: row.terminalOutcome } : {}),
  };
}

/** Read the retained first-dispatch placement after the caller authorizes the intent. */
export async function readTaskLaunchReceipt(
  db: Db,
  row: typeof taskLaunchIntents.$inferSelect,
): Promise<TaskLaunchReceipt> {
  const receipt = taskLaunchReceipt(row);
  const selection = receipt.executionHostSelection;
  const dispatch = row.dispatchReceipt;
  const [[run], [saved], [actual]] = await Promise.all([
    row.runId
      ? db.select({ status: runs.status }).from(runs).where(eq(runs.id, row.runId))
      : [],
    selection
      ? db.select({ displayName: executionHosts.displayName }).from(executionHosts)
          .where(eq(executionHosts.id, selection.effectiveExecutionHostId))
      : [],
    selection && dispatch && row.runId && dispatch.runId === row.runId
      ? db.select({
          executionHostId: executionAssignments.executionHostId,
          displayName: executionHosts.displayName,
          assignmentEpoch: executionAssignments.epoch,
        }).from(executionAssignments)
          .innerJoin(executionHosts, eq(executionHosts.id, executionAssignments.executionHostId))
          .where(and(
            eq(executionAssignments.id, dispatch.assignmentId),
            eq(executionAssignments.epoch, dispatch.assignmentEpoch),
            eq(executionAssignments.runId, row.runId),
          ))
      : [],
  ]);

  return {
    ...receipt,
    ...(run ? { runStatus: run.status } : {}),
    ...(selection
      ? {
          executionHostPlacement: {
            savedDisplayName: saved?.displayName ?? null,
            actual: actual ?? null,
          },
        }
      : {}),
  };
}
