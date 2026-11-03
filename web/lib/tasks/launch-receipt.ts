import "server-only";

import type { TaskLaunchReceipt } from "./launch-types";
import type { taskLaunchIntents } from "@/lib/db/schema";

export function taskLaunchReceipt(
  row: typeof taskLaunchIntents.$inferSelect,
): TaskLaunchReceipt {
  const settings = row.settingsSnapshot;

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
