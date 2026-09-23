import type { RunKind, ScratchDialogStatus } from "@/lib/db/schema";
import type { RunStatusValue } from "@/lib/runs/run-status-values";

// ADR-181 D1 — THE predicate for every run workbench git action. Pure and
// client-safe: facts come from the D1a loader (`facts.ts`) or, on cards and rail
// rows, from the row itself. `lib/workbench-lifecycle/policy.ts` re-exports it,
// so there is one vocabulary for policy ids, DTO ids, UI ids, testids and i18n
// keys.

export type WorkbenchGitActionId =
  | "stop"
  | "archive"
  | "drop"
  // ADR names → ids: publish → exportBranch, commit → snapshotCommit,
  // discard → discardChanges.
  | "exportBranch"
  | "snapshotCommit"
  | "discardChanges"
  | "update"
  | "openPr"
  | "finalizePr"
  | "reattach";

export const WORKBENCH_GIT_ACTION_ORDER: readonly WorkbenchGitActionId[] = [
  "stop",
  "archive",
  "drop",
  "exportBranch",
  "snapshotCommit",
  "discardChanges",
  "update",
  "openPr",
  "finalizePr",
  "reattach",
];

export type WorkbenchGitDisabledReason =
  | "live-workbench"
  | "human-owned"
  | "missing-workspace"
  | "removed-workspace"
  | "worktree-missing"
  | "worktree-present"
  | "busy"
  | "unsupported-status"
  | "unsupported-run"
  | "promoted"
  | "no-remote"
  | "not-published"
  | "no-reattach-source"
  | "pr-missing"
  | "pr-closed";

export type WorkbenchGitAction = {
  id: WorkbenchGitActionId;
  enabled: boolean;
  disabledReason: WorkbenchGitDisabledReason | null;
};

export type WorkbenchGitPolicyInput = {
  runKind: RunKind;
  // An unknown runtime string admits nothing (allow-list, never a deny-list).
  runStatus: RunStatusValue | (string & {});
  scratchDialogStatus: ScratchDialogStatus | null;
  hasWorkspace: boolean;
  workspaceRemoved: boolean;
  // Legacy input kept for existing callers; no action depends on it.
  workspaceArchived?: boolean;
  // ADR-160: `owner_user_id` of an OPEN rework claim, and the acting user.
  claimOwnerUserId: string | null | undefined;
  viewerUserId: string | null | undefined;
  // Facts (C32). A git-probed fact left null/undefined means "not probed" and
  // never hides an action — a card or rail row does not run git. A DB fact is
  // `null` when known absent and `undefined` when the caller did not load it.
  worktreePresent?: boolean | null;
  busy?: boolean;
  promotionState?: string | null;
  publishedBranch?: string | null;
  hasRemote?: boolean | null;
  prUrl?: string | null;
  prState?: "open" | "merged" | "closed" | null;
  updateSupported?: boolean;
  reattachSource?: boolean | null;
};

type StatusClass = "live" | "parked" | "human";

// Exhaustive: a twelfth run status is a compile error here, not a silent gap.
const STATUS_CLASS = {
  Pending: "live",
  Running: "live",
  NeedsInput: "live",
  NeedsInputIdle: "live",
  WaitingOnChildren: "live",
  HumanWorking: "human",
  Review: "parked",
  Crashed: "parked",
  Failed: "parked",
  Done: "parked",
  Abandoned: "parked",
} as const satisfies Record<RunStatusValue, StatusClass>;

// One source for every "the tree may be operated on" check: this policy, sync
// admission (T2.1) and the finalize allow-list below.
export const WORKTREE_ACTION_STATUSES: ReadonlySet<string> = new Set(
  (Object.keys(STATUS_CLASS) as RunStatusValue[]).filter(
    (s) => STATUS_CLASS[s] === "parked",
  ),
);

// ADR-181 D6 (amendment C22): finalize from Review (through promoteRun) and
// from the three terminal-parked statuses; a Done run is already finalized.
const FINALIZE_STATUSES: ReadonlySet<string> = new Set([
  "Review",
  "Crashed",
  "Failed",
  "Abandoned",
]);

const FLOW_STOP_STATUSES: ReadonlySet<string> = new Set([
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
]);

const SCRATCH_STOP_DIALOG_STATUSES: ReadonlySet<string> = new Set([
  "Starting",
  "WaitingForUser",
  "Running",
  "NeedsInput",
]);

// The claim owner is mid-handoff: removing the worktree under them, stopping,
// or changing the run's status (finalize) is never right while the claim is
// open (C22).
const OWNER_FORBIDDEN: ReadonlySet<WorkbenchGitActionId> = new Set([
  "stop",
  "archive",
  "drop",
  "finalizePr",
]);

function statusClass(status: string): StatusClass | null {
  return Object.prototype.hasOwnProperty.call(STATUS_CLASS, status)
    ? STATUS_CLASS[status as RunStatusValue]
    : null;
}

// The single definition of "this run is still live enough to stop". Exported so
// callers that re-drive a stop (the ADR-161 node-interrupt self-heal) gate on
// the same set the policy enforces.
export function isStoppableRunStatus(status: string): boolean {
  return FLOW_STOP_STATUSES.has(status);
}

function isStopAllowed(input: WorkbenchGitPolicyInput): boolean {
  if (input.runKind === "scratch" && input.scratchDialogStatus) {
    return SCRATCH_STOP_DIALOG_STATUSES.has(input.scratchDialogStatus);
  }

  return isStoppableRunStatus(input.runStatus);
}

// Compare only two REAL ids: `undefined === undefined` from a caller that
// omitted both fields must never open the carve-out.
function isClaimOwner(input: WorkbenchGitPolicyInput): boolean {
  const owner = input.claimOwnerUserId;
  const viewer = input.viewerUserId;

  return (
    typeof owner === "string" &&
    owner.length > 0 &&
    typeof viewer === "string" &&
    owner === viewer
  );
}

function allOrdered(
  decide: (id: WorkbenchGitActionId) => WorkbenchGitDisabledReason | null,
): WorkbenchGitAction[] {
  return WORKBENCH_GIT_ACTION_ORDER.map((id) => {
    const disabledReason = decide(id);

    return { id, enabled: disabledReason === null, disabledReason };
  });
}

// Why a usable, idle worktree still refuses `id` — the per-action facts.
function factRefusal(
  id: WorkbenchGitActionId,
  input: WorkbenchGitPolicyInput,
): WorkbenchGitDisabledReason | null {
  switch (id) {
    case "stop":
      return "unsupported-status";
    case "archive":
    case "drop":
    case "snapshotCommit":
    case "discardChanges":
      return null;
    case "exportBranch":
      return input.hasRemote === false ? "no-remote" : null;
    case "update":
      if (input.runKind === "scratch" || input.updateSupported === false) {
        return "unsupported-run";
      }
      if (input.promotionState === "done") return "promoted";
      // Sync's forward fence refuses a promotion claim even when it is stale.
      if (input.promotionState === "claiming") return "busy";

      return null;
    case "openPr":
      if (input.hasRemote === false) return "no-remote";
      if (input.publishedBranch === null) return "not-published";

      return null;
    case "finalizePr":
      if (!FINALIZE_STATUSES.has(input.runStatus)) return "unsupported-status";
      if (input.prUrl === null) return "pr-missing";
      if (input.prState === "closed") return "pr-closed";

      return null;
    case "reattach":
      return "worktree-present";
  }
}

export function deriveWorkbenchGitActions(
  input: WorkbenchGitPolicyInput,
): WorkbenchGitAction[] {
  const cls = statusClass(input.runStatus);

  if (cls === null) return allOrdered(() => "unsupported-status");

  const owner = cls === "human" && isClaimOwner(input);

  if (cls === "human" && !owner) return allOrdered(() => "human-owned");

  if (cls !== "human" && isStopAllowed(input)) {
    return allOrdered((id) => (id === "stop" ? null : "live-workbench"));
  }

  if (cls === "live") return allOrdered(() => "unsupported-status");

  const usable = !input.workspaceRemoved && input.worktreePresent !== false;

  return allOrdered((id) => {
    if (owner && OWNER_FORBIDDEN.has(id)) return "human-owned";
    if (!input.hasWorkspace) return "missing-workspace";

    if (!usable) {
      if (id !== "reattach") {
        return input.workspaceRemoved
          ? "removed-workspace"
          : "worktree-missing";
      }
      if (input.busy === true) return "busy";

      return input.reattachSource === false ? "no-reattach-source" : null;
    }

    if (input.busy === true)
      return id === "stop" ? "unsupported-status" : "busy";

    return factRefusal(id, input);
  });
}

// C19: a policy refusal's `details.reason` — the disabled reason in snake_case,
// one vocabulary mechanically transformed.
export function disabledReasonToken(
  reason: WorkbenchGitDisabledReason,
): string {
  return reason.replace(/-/g, "_");
}
