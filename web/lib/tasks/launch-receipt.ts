import "server-only";

import type {
  TaskLaunchReceipt,
  TaskLaunchSettingsSnapshot,
} from "./launch-types";
import type { taskLaunchIntents } from "@/lib/db/schema";
import type { TaskLaunchHostSelection } from "@/lib/execution-host/project-preference";

import { retryDigest } from "@/lib/agents/retry-guards";
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
