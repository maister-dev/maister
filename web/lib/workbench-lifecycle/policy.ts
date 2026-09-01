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
  // M37 (ADR-098 T7.4): valid run status; a parked orchestrator is intentionally
  // NOT in any workbench action set here — it is cancelled (sub-tree cascade) via
  // the abandon route, not workbench stop/drop, so it reads as unsupported-status.
  | "WaitingOnChildren"
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
  // ADR-160: `owner_user_id` of an OPEN rework claim (`decision =
  // 'review_rework_claim'`), else null. An M11b takeover leaves this null, so
  // it never opens the carve-out below.
  claimOwnerUserId: string | null;
  // The acting user, for the owner comparison. Null for an anonymous/system
  // derivation, which never matches.
  viewerUserId: string | null;
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

// The single definition of "this run is still live enough to stop". Exported so
// callers that re-drive a stop (the ADR-161 node-interrupt self-heal) gate on
// the same set the policy enforces, instead of keeping a second copy that
// drifts when the set changes.
export function isStoppableRunStatus(status: string): boolean {
  return FLOW_STOP_STATUSES.has(status as WorkbenchRunStatus);
}

function isStopAllowed(args: WorkbenchLifecyclePolicyInput): boolean {
  if (args.runKind === "scratch") {
    return args.scratchDialogStatus
      ? SCRATCH_STOP_DIALOG_STATUSES.has(args.scratchDialogStatus)
      : isStoppableRunStatus(args.runStatus);
  }

  return isStoppableRunStatus(args.runStatus);
}

function isWorktreeActionAllowed(args: WorkbenchLifecyclePolicyInput): boolean {
  return WORKTREE_ACTION_STATUSES.has(args.runStatus);
}

// ADR-160: the ONE hole in the `human-owned` wall. `exportBranch` is the single
// action opened, and only to the claim owner on a present workspace — but it is
// what makes snapshotCommit / handoffBranch / handoff-metadata reachable during
// a claim, since all three gate on `requireActionAllowed(ctx, "exportBranch")`.
// That coupling is deliberate: the claim exists so the operator can get the
// branch out to another machine and push fixes back.
function ownsOpenReworkClaim(args: WorkbenchLifecyclePolicyInput): boolean {
  const owner = args.claimOwnerUserId;
  const viewer = args.viewerUserId;

  // Compare only two REAL ids. A `!== null` pair would let two absent values
  // (`undefined === undefined` from a caller that omits the fields) match each
  // other and open the carve-out on any HumanWorking run.
  return (
    typeof owner === "string" &&
    owner.length > 0 &&
    typeof viewer === "string" &&
    owner === viewer &&
    args.hasWorkspace &&
    !args.workspaceRemoved
  );
}

export function deriveWorkbenchLifecycleActions(
  args: WorkbenchLifecyclePolicyInput,
): WorkbenchLifecycleAction[] {
  if (args.runStatus === "HumanWorking") {
    if (!ownsOpenReworkClaim(args)) return disabledActions("human-owned");

    // stop/archive/drop stay refused even for the owner: the run is mid-handoff
    // and removing its worktree under the operator editing it is never right.
    return ACTION_ORDER.map((id) =>
      action(id, id === "exportBranch", "human-owned"),
    );
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
