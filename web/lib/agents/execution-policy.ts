// Agent runner-policy resolution (ADR-106, M39 Phase 5). The agent definition
// ships a SIMPLIFIED policy projection (`recommended.executionPolicy =
// { autoApply, onBudgetBreach }`); the per-project instance
// (`agent_project_links.execution_policy_override`) overrides it PER FIELD. This
// module folds that simplified projection onto the rich ExecutionPolicy
// (lib/runs/execution-policy.ts) so a single resolved policy can be snapshotted
// onto runs.execution_policy at launch — the same column the flow runner +
// budget watchdog already read back.
//
// Mapping (owner-confirmed, ADR-106):
//  - autoApply 'off'         → B1 permissions=ask,          B2 humanGate=stop
//  - autoApply 'permissions' → B1 permissions=auto_approve, B2 humanGate=stop   ("с чел")
//  - autoApply 'full'        → B1 permissions=auto_approve, B2 humanGate=auto_pass ("без чел")
//  - autoApply unset         → inherit the base preset/overrides (no change)
//  - onBudgetBreach          → the ADR-106 onBudgetBreach axis (unset = inherit)
//
// Precedence (Q3, per field): instance override → agent recommended → base.

import type { AgentExecutionPolicyRecommendation } from "@/lib/db/schema";

import {
  type ExecutionPolicy,
  type ExecutionPolicyOverrides,
  defaultExecutionPolicy,
} from "@/lib/runs/execution-policy";

export function resolveAgentExecutionPolicy(args: {
  instanceOverride?: AgentExecutionPolicyRecommendation | null;
  recommended?: AgentExecutionPolicyRecommendation | null;
  base?: ExecutionPolicy | null;
}): ExecutionPolicy {
  const autoApply =
    args.instanceOverride?.autoApply ?? args.recommended?.autoApply;
  const onBudgetBreach =
    args.instanceOverride?.onBudgetBreach ?? args.recommended?.onBudgetBreach;

  const base = args.base ?? defaultExecutionPolicy();
  const overrides: ExecutionPolicyOverrides = { ...(base.overrides ?? {}) };

  // autoApply → B1 permissions + B2 humanGate. An explicit value (incl. 'off')
  // overrides the base so an agent can force normal HITL on an auto preset.
  if (autoApply === "off") {
    overrides.permissions = "ask";
    overrides.humanGate = "stop";
  } else if (autoApply === "permissions") {
    overrides.permissions = "auto_approve";
    overrides.humanGate = "stop";
  } else if (autoApply === "full") {
    overrides.permissions = "auto_approve";
    overrides.humanGate = "auto_pass";
  }
  // autoApply unset → inherit base permissions/humanGate.

  if (onBudgetBreach) overrides.onBudgetBreach = onBudgetBreach;

  // Omit an empty overrides object so the no-policy case snapshots identically to
  // the runs.execution_policy column default (`{ preset: "supervised" }`).
  return Object.keys(overrides).length > 0
    ? { preset: base.preset, overrides }
    : { preset: base.preset };
}
