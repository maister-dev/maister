// Flow execution-control policy. Composable axes grouped A (machine
// self-correction) / B (human escalation) / C (output shaping); see
// docs/plans/2026-06-18-flow-execution-control-policy-plan.md for the axis map.
// A run carries a preset that sets every axis, plus optional per-axis overrides,
// snapshotted onto runs.execution_policy at launch (resume/recover read the
// snapshot, like runner_snapshot). This module is client-safe (errors-core, no
// server-only): the launch UI reuses expandExecutionPolicy + isBlindShip.

import { z } from "zod";

import { MaisterError } from "@/lib/errors-core";

export type ExecutionPreset = "supervised" | "assisted" | "unattended";

// A1 — rework on-exhaustion action (the judge loop's cap is the flow author's;
// policy may lower it and pick what happens when it is exhausted).
export type ReworkExhaustionAction = "escalate" | "ship_with_warning" | "fail";

// A2 — crash / hard-failure handling.
export type CrashRetryMode = "fail" | "ralph_loop" | "auto_retry";

// A3 — non-review check-gate strictness (promotion-block only; never the judge).
export type CheckStrictness = "strict" | "advisory" | "skip";

// B1 — ACP tool-permission autonomy.
export type PermissionAutonomy = "ask" | "auto_approve";

// B2 — human-gate autonomy (auto_pass fires only after Group A passed).
export type HumanGateAutonomy = "stop" | "auto_pass";

// B3 — what happens when the machine is stuck.
export type OnStuckAction = "escalate" | "ship_with_warning" | "notify_only";

// C1 — promotion trigger.
export type PromotionTrigger = "manual" | "auto_on_ready";

// C2 — how much commit history survives.
export type CommitPolicy =
  | "keep_all"
  | "squash_rework"
  | "squash_on_promote"
  | "defer";

// C3 — dirty-worktree resolution (discard is never an automatic value).
export type DirtyResolution = "ask" | "commit" | "proceed";

export type ExecutionPolicyOverrides = {
  reworkExhaustion?: ReworkExhaustionAction;
  crashRetry?: CrashRetryMode;
  checks?: CheckStrictness;
  permissions?: PermissionAutonomy;
  humanGate?: HumanGateAutonomy;
  onStuck?: OnStuckAction;
  promotion?: PromotionTrigger;
  commits?: CommitPolicy;
  dirtyResolve?: DirtyResolution;
};

export type ExecutionPolicy = {
  preset: ExecutionPreset;
  overrides?: ExecutionPolicyOverrides;
};

// Every axis resolved to a concrete value (preset expansion + overrides folded).
export type ResolvedExecutionPolicy = {
  preset: ExecutionPreset;
  reworkExhaustion: ReworkExhaustionAction;
  crashRetry: CrashRetryMode;
  checks: CheckStrictness;
  permissions: PermissionAutonomy;
  humanGate: HumanGateAutonomy;
  onStuck: OnStuckAction;
  promotion: PromotionTrigger;
  commits: CommitPolicy;
  dirtyResolve: DirtyResolution;
};

type PresetAxes = Omit<ResolvedExecutionPolicy, "preset">;

// The canonical preset → axes table (umbrella design "Preset levels"). No preset
// alone trips the no-blind-ship guard: checks stay `strict` at every level, so
// auto-pass / auto-promote always sit behind at least one validation layer.
const PRESET_AXES: Record<ExecutionPreset, PresetAxes> = {
  supervised: {
    reworkExhaustion: "escalate",
    crashRetry: "fail",
    checks: "strict",
    permissions: "ask",
    humanGate: "stop",
    onStuck: "escalate",
    promotion: "manual",
    commits: "keep_all",
    dirtyResolve: "ask",
  },
  assisted: {
    reworkExhaustion: "escalate",
    crashRetry: "fail",
    checks: "strict",
    permissions: "auto_approve",
    humanGate: "stop",
    onStuck: "escalate",
    promotion: "manual",
    commits: "keep_all",
    dirtyResolve: "proceed",
  },
  unattended: {
    reworkExhaustion: "escalate",
    crashRetry: "ralph_loop",
    checks: "strict",
    permissions: "auto_approve",
    humanGate: "auto_pass",
    onStuck: "escalate",
    promotion: "auto_on_ready",
    commits: "squash_rework",
    dirtyResolve: "proceed",
  },
};

export function expandExecutionPolicy(
  policy: ExecutionPolicy,
): ResolvedExecutionPolicy {
  const base = PRESET_AXES[policy.preset];
  const o = policy.overrides ?? {};

  return {
    preset: policy.preset,
    reworkExhaustion: o.reworkExhaustion ?? base.reworkExhaustion,
    crashRetry: o.crashRetry ?? base.crashRetry,
    checks: o.checks ?? base.checks,
    permissions: o.permissions ?? base.permissions,
    humanGate: o.humanGate ?? base.humanGate,
    onStuck: o.onStuck ?? base.onStuck,
    promotion: o.promotion ?? base.promotion,
    commits: o.commits ?? base.commits,
    dirtyResolve: o.dirtyResolve ?? base.dirtyResolve,
  };
}

export function defaultExecutionPolicy(): ExecutionPolicy {
  return { preset: "supervised" };
}

// Precedence: launch override → task default → project default → supervised.
// A platform-default tier slots in before `supervised` once a platform settings
// column backs it (migration 0055 ships project + task defaults only).
export function resolveExecutionPolicy(args: {
  launchOverride?: ExecutionPolicy | null;
  taskDefault?: ExecutionPolicy | null;
  projectDefault?: ExecutionPolicy | null;
}): ExecutionPolicy {
  return (
    args.launchOverride ??
    args.taskDefault ??
    args.projectDefault ??
    defaultExecutionPolicy()
  );
}

// The no-blind-ship invariant: never ship with zero validation. Relaxing the
// check gates (A3 advisory/skip) is forbidden in combination with EITHER
// auto-passing the human gate (B2) OR auto-promotion (C1) — at least one of a
// human review or a manual promote must remain to gate an automatic ship.
export function isBlindShip(policy: ExecutionPolicy): boolean {
  const r = expandExecutionPolicy(policy);
  const checksRelaxed = r.checks !== "strict";
  const noHumanFloor =
    r.humanGate === "auto_pass" || r.promotion === "auto_on_ready";

  return checksRelaxed && noHumanFloor;
}

export function assertNoBlindShip(policy: ExecutionPolicy): void {
  if (isBlindShip(policy)) {
    throw new MaisterError(
      "PRECONDITION",
      "Execution policy would ship with no validation: relaxed checks (advisory/skip) cannot be combined with auto-passed human gates or auto-promotion. Keep checks strict, or keep a human review / manual promotion.",
    );
  }
}

// A policy needs the privileged `launchUnattended` project action when it lowers
// human oversight or validation below the supervised floor: auto-passing the
// human gate, auto-promoting, relaxing checks, or not escalating when stuck. The
// `unattended` preset is always covered (it sets auto_pass + auto_on_ready);
// `assisted` only auto-approves permissions + proceeds on a dirty tree — it
// keeps human review and manual promotion, so it stays at the launchRun level.
export function requiresLaunchUnattended(policy: ExecutionPolicy): boolean {
  const r = expandExecutionPolicy(policy);

  return (
    r.humanGate === "auto_pass" ||
    r.promotion === "auto_on_ready" ||
    r.checks !== "strict" ||
    r.onStuck !== "escalate"
  );
}

// Launch-UI projection of the no-blind-ship invariant: given the current
// A3/B2/C1 selections, which conflicting options the launch dialog must disable
// so an operator cannot pick a blind-ship combo in the first place (the server
// still re-validates via assertNoBlindShip).
export type BlindShipAxes = {
  checks: CheckStrictness;
  humanGate: HumanGateAutonomy;
  promotion: PromotionTrigger;
};

export function blindShipLockedOptions(current: BlindShipAxes): {
  relaxedChecksDisabled: boolean;
  autoPassDisabled: boolean;
  autoPromoteDisabled: boolean;
} {
  const autoShip =
    current.humanGate === "auto_pass" || current.promotion === "auto_on_ready";
  const checksRelaxed = current.checks !== "strict";

  return {
    relaxedChecksDisabled: autoShip,
    autoPassDisabled: checksRelaxed,
    autoPromoteDisabled: checksRelaxed,
  };
}

export const executionPresetSchema = z.enum([
  "supervised",
  "assisted",
  "unattended",
]);

export const executionPolicyOverridesSchema = z
  .object({
    reworkExhaustion: z.enum(["escalate", "ship_with_warning", "fail"]),
    crashRetry: z.enum(["fail", "ralph_loop", "auto_retry"]),
    checks: z.enum(["strict", "advisory", "skip"]),
    permissions: z.enum(["ask", "auto_approve"]),
    humanGate: z.enum(["stop", "auto_pass"]),
    onStuck: z.enum(["escalate", "ship_with_warning", "notify_only"]),
    promotion: z.enum(["manual", "auto_on_ready"]),
    commits: z.enum([
      "keep_all",
      "squash_rework",
      "squash_on_promote",
      "defer",
    ]),
    dirtyResolve: z.enum(["ask", "commit", "proceed"]),
  })
  .partial()
  .strict();

export const executionPolicySchema = z
  .object({
    preset: executionPresetSchema,
    overrides: executionPolicyOverridesSchema.optional(),
  })
  .strict();

// Resolve just the check-strictness axis (A3) from a run's execution_policy
// snapshot. The column is open jsonb (validated at launch, read back untyped),
// so fail closed: a null / absent / malformed snapshot resolves to `strict` —
// a corrupt policy can never silently relax the promotion checks.
export function checksFromSnapshot(snapshot: unknown): CheckStrictness {
  const parsed = executionPolicySchema.safeParse(snapshot);

  return parsed.success ? expandExecutionPolicy(parsed.data).checks : "strict";
}
