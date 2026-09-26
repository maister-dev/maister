import type { RunStatusValue } from "@/lib/runs/run-status-values";

import {
  deriveWorkbenchGitActions,
  type WorkbenchGitAction,
  type WorkbenchGitActionId,
  type WorkbenchGitDisabledReason,
  type WorkbenchGitPolicyInput,
} from "@/lib/workbench-git/policy";

// ADR-181 C32: the lifecycle vocabulary is the git policy's, re-exported so the
// existing callers keep their imports. There is ONE predicate
// (`lib/workbench-git/policy.ts`); nothing here decides anything.

export type WorkbenchLifecycleActionId = WorkbenchGitActionId;

// M37 (ADR-098 T7.4): a parked orchestrator (`WaitingOnChildren`) is in no
// workbench action set — it is cancelled (sub-tree cascade) via the abandon
// route, not workbench stop/drop, so it reads as unsupported-status.
export type WorkbenchRunStatus = RunStatusValue;

export type WorkbenchLifecycleDisabledReason = WorkbenchGitDisabledReason;

export type WorkbenchLifecycleAction = WorkbenchGitAction;

export type WorkbenchLifecyclePolicyInput = WorkbenchGitPolicyInput;

export { isStoppableRunStatus } from "@/lib/workbench-git/policy";

export function deriveWorkbenchLifecycleActions(
  args: WorkbenchLifecyclePolicyInput,
): WorkbenchLifecycleAction[] {
  return deriveWorkbenchGitActions(args);
}
