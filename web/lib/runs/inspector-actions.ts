import type { RunKind, ScratchDialogStatus } from "@/lib/db/schema";
import type {
  WorkbenchLifecycleDisabledReason,
  WorkbenchRunStatus,
} from "@/lib/workbench-lifecycle/policy";

import { deriveWorkbenchLifecycleActions } from "@/lib/workbench-lifecycle/policy";

export type InspectorActionGroup =
  | "session"
  | "branch"
  | "delivery"
  | "cleanup";

export type InspectorActionId =
  | "stop"
  | "recover"
  | "snapshotCommit"
  | "exportBranch"
  | "handoffBranch"
  | "promote"
  | "promotePullRequest"
  | "archive"
  | "drop";

export type InspectorActionDisabledReason =
  | WorkbenchLifecycleDisabledReason
  | "not-crashed"
  | "recover-unavailable"
  | "review-not-ready"
  | "target-drift"
  | "diff-truncated"
  | "missing-review-target"
  | "unsupported-delivery";

export interface InspectorActionDto {
  id: InspectorActionId;
  group: InspectorActionGroup;
  endpoint: string | null;
  method: "POST" | null;
  enabled: boolean;
  disabledReason: InspectorActionDisabledReason | null;
}

export interface InspectorActionPolicyInput {
  runId: string;
  runKind: RunKind;
  runStatus: WorkbenchRunStatus;
  scratchDialogStatus: ScratchDialogStatus | null;
  hasWorkspace: boolean;
  workspaceRemoved: boolean;
  workspaceArchived: boolean;
  recoverable: boolean;
  canPromote: boolean;
  reviewReady: boolean;
  targetDriftDetected: boolean;
  diffTruncated: boolean;
  reviewedTargetCommit: string | null;
  deliveryMode: "local" | "pull_request" | null;
}

function endpointFor(input: {
  runId: string;
  runKind: RunKind;
  id: InspectorActionId;
}): string | null {
  if (input.id === "stop" && input.runKind === "scratch") {
    return `/api/scratch-runs/${input.runId}/stop`;
  }

  const pathById: Record<InspectorActionId, string | null> = {
    stop: "stop",
    recover: "recover",
    snapshotCommit: "snapshot-commit",
    exportBranch: "export-branch",
    handoffBranch: "handoff-branch",
    promote: "promote",
    promotePullRequest: "promote",
    archive: "archive",
    drop: "drop",
  };
  const path = pathById[input.id];

  return path ? `/api/runs/${input.runId}/${path}` : null;
}

function action(input: {
  runId: string;
  runKind: RunKind;
  id: InspectorActionId;
  group: InspectorActionGroup;
  enabled: boolean;
  disabledReason: InspectorActionDisabledReason | null;
}): InspectorActionDto {
  return {
    id: input.id,
    group: input.group,
    endpoint: endpointFor(input),
    method: "POST",
    enabled: input.enabled,
    disabledReason: input.enabled ? null : input.disabledReason,
  };
}

function lifecycleAction(input: {
  runId: string;
  runKind: RunKind;
  id: InspectorActionId;
  group: InspectorActionGroup;
  enabled: boolean;
  disabledReason: WorkbenchLifecycleDisabledReason | null;
}): InspectorActionDto {
  return action({
    runId: input.runId,
    runKind: input.runKind,
    id: input.id,
    group: input.group,
    enabled: input.enabled,
    disabledReason: input.disabledReason ?? "unsupported-status",
  });
}

function deliveryDisabledReason(
  input: InspectorActionPolicyInput,
): InspectorActionDisabledReason | null {
  if (!input.canPromote) return "review-not-ready";
  if (input.diffTruncated) return "diff-truncated";
  if (input.targetDriftDetected) return "target-drift";
  if (!input.reviewedTargetCommit) return "missing-review-target";
  if (!input.reviewReady) return "review-not-ready";

  return null;
}

export function deriveInspectorActions(
  input: InspectorActionPolicyInput,
): InspectorActionDto[] {
  const lifecycle = deriveWorkbenchLifecycleActions({
    runKind: input.runKind,
    runStatus: input.runStatus,
    scratchDialogStatus: input.scratchDialogStatus,
    hasWorkspace: input.hasWorkspace,
    workspaceRemoved: input.workspaceRemoved,
    workspaceArchived: input.workspaceArchived,
  });
  const lifecycleById = new Map(lifecycle.map((item) => [item.id, item]));
  const stop = lifecycleById.get("stop");
  const archive = lifecycleById.get("archive");
  const drop = lifecycleById.get("drop");
  const exportBranch = lifecycleById.get("exportBranch");
  const canPreserveBranch = exportBranch?.enabled === true;
  const branchDisabledReason =
    exportBranch?.disabledReason ?? "unsupported-status";
  const deliveryReason = deliveryDisabledReason(input);
  const deliveryEnabled =
    input.runStatus === "Review" &&
    input.deliveryMode !== null &&
    deliveryReason === null;
  const deliveryId =
    input.deliveryMode === "pull_request" ? "promotePullRequest" : "promote";

  return [
    lifecycleAction({
      runId: input.runId,
      runKind: input.runKind,
      id: "stop",
      group: "session",
      enabled: stop?.enabled === true,
      disabledReason: stop?.disabledReason ?? "unsupported-status",
    }),
    action({
      runId: input.runId,
      runKind: input.runKind,
      id: "recover",
      group: "session",
      enabled: input.runStatus === "Crashed" && input.recoverable,
      disabledReason:
        input.runStatus === "Crashed" ? "recover-unavailable" : "not-crashed",
    }),
    action({
      runId: input.runId,
      runKind: input.runKind,
      id: "snapshotCommit",
      group: "branch",
      enabled: canPreserveBranch,
      disabledReason: branchDisabledReason,
    }),
    lifecycleAction({
      runId: input.runId,
      runKind: input.runKind,
      id: "exportBranch",
      group: "branch",
      enabled: canPreserveBranch,
      disabledReason: branchDisabledReason,
    }),
    action({
      runId: input.runId,
      runKind: input.runKind,
      id: "handoffBranch",
      group: "branch",
      enabled: canPreserveBranch,
      disabledReason: branchDisabledReason,
    }),
    action({
      runId: input.runId,
      runKind: input.runKind,
      id: deliveryId,
      group: "delivery",
      enabled: deliveryEnabled,
      disabledReason:
        input.runStatus === "Review"
          ? (deliveryReason ?? "unsupported-delivery")
          : "unsupported-status",
    }),
    lifecycleAction({
      runId: input.runId,
      runKind: input.runKind,
      id: "archive",
      group: "cleanup",
      enabled: archive?.enabled === true,
      disabledReason: archive?.disabledReason ?? "unsupported-status",
    }),
    lifecycleAction({
      runId: input.runId,
      runKind: input.runKind,
      id: "drop",
      group: "cleanup",
      enabled: drop?.enabled === true,
      disabledReason: drop?.disabledReason ?? "unsupported-status",
    }),
  ];
}
