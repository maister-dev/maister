import type { RunKind, ScratchDialogStatus } from "@/lib/db/schema";

export type WorkbenchLifecycleActionId =
  | "stop"
  | "archive"
  | "drop"
  | "exportBranch";

export type WorkbenchRunStatus =
  | "Pending"
  | "Running"
  | "NeedsInput"
  | "NeedsInputIdle"
  | "HumanWorking"
  | "Review"
  | "Crashed"
  | "Done"
  | "Abandoned"
  | "Failed";

export type WorkbenchLifecycleDisabledReason =
  | "live-workbench"
  | "missing-workspace"
  | "removed-workspace"
  | "human-owned"
  | "unsupported-status";

export type WorkbenchLifecycleAction = {
  id: WorkbenchLifecycleActionId;
  enabled: boolean;
  disabledReason: WorkbenchLifecycleDisabledReason | null;
};

export type WorkbenchLifecyclePolicyInput = {
  runKind: RunKind;
  runStatus: WorkbenchRunStatus;
  scratchDialogStatus: ScratchDialogStatus | null;
  hasWorkspace: boolean;
  workspaceRemoved: boolean;
  workspaceArchived: boolean;
};

const ACTION_ORDER: WorkbenchLifecycleActionId[] = [
  "stop",
  "archive",
  "drop",
  "exportBranch",
];

const FLOW_STOP_STATUSES = new Set<WorkbenchRunStatus>([
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
]);

const SCRATCH_STOP_DIALOG_STATUSES = new Set<ScratchDialogStatus>([
  "Starting",
  "WaitingForUser",
  "Running",
  "NeedsInput",
]);

const WORKTREE_ACTION_STATUSES = new Set<WorkbenchRunStatus>([
  "Review",
  "Crashed",
  "Done",
  "Abandoned",
  "Failed",
]);

function action(
  id: WorkbenchLifecycleActionId,
  enabled: boolean,
  disabledReason: WorkbenchLifecycleDisabledReason | null,
): WorkbenchLifecycleAction {
  return { id, enabled, disabledReason: enabled ? null : disabledReason };
}

function disabledActions(
  disabledReason: WorkbenchLifecycleDisabledReason,
): WorkbenchLifecycleAction[] {
  return ACTION_ORDER.map((id) => action(id, false, disabledReason));
}

function isStopAllowed(args: WorkbenchLifecyclePolicyInput): boolean {
  if (args.runKind === "scratch") {
    return args.scratchDialogStatus
      ? SCRATCH_STOP_DIALOG_STATUSES.has(args.scratchDialogStatus)
      : FLOW_STOP_STATUSES.has(args.runStatus);
  }

  return FLOW_STOP_STATUSES.has(args.runStatus);
}

function isWorktreeActionAllowed(args: WorkbenchLifecyclePolicyInput): boolean {
  return WORKTREE_ACTION_STATUSES.has(args.runStatus);
}

export function deriveWorkbenchLifecycleActions(
  args: WorkbenchLifecyclePolicyInput,
): WorkbenchLifecycleAction[] {
  if (args.runStatus === "HumanWorking") {
    return disabledActions("human-owned");
  }

  if (isStopAllowed(args)) {
    return ACTION_ORDER.map((id) =>
      action(id, id === "stop", id === "stop" ? null : "live-workbench"),
    );
  }

  if (!isWorktreeActionAllowed(args)) {
    return disabledActions("unsupported-status");
  }

  if (!args.hasWorkspace) {
    return disabledActions("missing-workspace");
  }

  if (args.workspaceRemoved) {
    return disabledActions("removed-workspace");
  }

  return ACTION_ORDER.map((id) =>
    action(id, id !== "stop", id === "stop" ? "unsupported-status" : null),
  );
}
