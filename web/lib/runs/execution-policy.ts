// Flow execution-control policy. Composable axes grouped A (machine
// self-correction) / B (human escalation) / C (output shaping); see
// docs/plans/2026-06-18-flow-execution-control-policy-plan.md for the axis map.
// A run carries a preset that sets every axis, plus optional per-axis overrides,
// snapshotted onto runs.execution_policy at launch (resume/recover read the
// snapshot, like runner_snapshot). This module is client-safe (errors-core, no
// server-only): the launch UI reuses expandExecutionPolicy + isBlindShip.

import { z } from "zod";

import { RETRYABLE_ERROR_CODES, type RetryPolicy } from "@/lib/config.schema";
import { MaisterError } from "@/lib/errors-core";

export type ExecutionPreset = "supervised" | "assisted" | "unattended";

// A1 — rework on-exhaustion action (the judge loop's cap is the flow author's;
// policy may lower it and pick what happens when it is exhausted).
export type ReworkExhaustionAction = "escalate" | "ship_with_warning" | "fail";

// A2 — crash / hard-failure handling. `ralph_loop` relaunches the WHOLE run on
// Failed (the run.failed consumer); `auto_retry` re-dispatches a failed
// `retry_safe` node IN-RUN on a transient code — synthesizing an ADR-080 retry
// (resolveAutoRetryPolicy) bounded by MAISTER_AUTO_RETRY_MAX_ATTEMPTS, with the
// author's per-node retry_policy taking precedence when present.
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

// Execution-policy axis A2 (crashRetry=auto_retry): synthesize an ADR-080 retry
// policy for a `retry_safe` node so a failed transient in-run dispatch is
// re-dispatched within the same run (no whole-run ralph relaunch). Returns null
// when the node is not retry_safe OR the run is not auto_retry. The caller lets
// an explicit per-node retry_policy WIN (author authoritative) and only falls
// back to this. on_errors is the transient allow-list (RETRYABLE_ERROR_CODES —
// SPAWN/EXECUTOR_UNAVAILABLE/CHECKPOINT/ACP_PROTOCOL; deterministic codes never
// retry); workspace=keep (no checkpoint dependency, mirrors the degraded path).
export function resolveAutoRetryPolicy(args: {
  retrySafe: boolean;
  executionPolicy: unknown;
  maxAttempts: number;
}): RetryPolicy | null {
  if (!args.retrySafe) return null;
  if (crashRetryFromSnapshot(args.executionPolicy) !== "auto_retry") {
    return null;
  }

  return {
    attempts: args.maxAttempts,
    on_errors: [...RETRYABLE_ERROR_CODES],
    workspace: "keep",
  };
}

// A policy needs the privileged `launchUnattended` project action when it lowers
// human oversight or validation below the supervised floor: auto-passing the
// human gate, auto-promoting, relaxing checks, or not escalating when stuck. The
// `unattended` preset is always covered (it sets auto_pass + auto_on_ready);
// `assisted` only auto-approves permissions + proceeds on a dirty tree — it
// keeps human review and manual promotion, so it stays at the launchRun level.
// NOTE: `reworkExhaustion=ship_with_warning` is intentionally NOT gated here.
// It can only ship behind a remaining human floor: the no-blind-ship guard
// forbids it with relaxed checks + auto-pass/auto-promote, so a human review or
// a manual promote still sees the result. It is launch-level by design (owner
// decision 2026-06-20) — revisit only if it becomes UI-reachable.
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

// Resolve just the rework-exhaustion axis (A1) from a run's execution_policy
// snapshot. Same fail-closed discipline as checksFromSnapshot: a null / absent /
// malformed snapshot resolves to `escalate` (the safe default — pause for a
// human rather than ship or fail on a corrupt policy).
export function reworkExhaustionFromSnapshot(
  snapshot: unknown,
): ReworkExhaustionAction {
  const parsed = executionPolicySchema.safeParse(snapshot);

  return parsed.success
    ? expandExecutionPolicy(parsed.data).reworkExhaustion
    : "escalate";
}

// Resolve just the crash-retry axis (A2) from a run's execution_policy snapshot.
// Fail closed: a null / absent / malformed snapshot resolves to `fail` — a
// corrupt policy must NEVER silently auto-relaunch (ralph_loop) a failed run.
export function crashRetryFromSnapshot(snapshot: unknown): CrashRetryMode {
  const parsed = executionPolicySchema.safeParse(snapshot);

  return parsed.success
    ? expandExecutionPolicy(parsed.data).crashRetry
    : "fail";
}

// Resolve just the permission-autonomy axis (B1) from a run's execution_policy
// snapshot. Fail closed: a null / absent / malformed snapshot resolves to `ask`
// — a corrupt policy must NEVER silently auto-approve tool permissions.
export function permissionsFromSnapshot(snapshot: unknown): PermissionAutonomy {
  const parsed = executionPolicySchema.safeParse(snapshot);

  return parsed.success
    ? expandExecutionPolicy(parsed.data).permissions
    : "ask";
}

// Resolve just the human-gate axis (B2) from a run's execution_policy snapshot.
// Fail closed: a null / absent / malformed snapshot resolves to `stop` — a
// corrupt policy must NEVER silently auto-pass a human gate.
export function humanGateFromSnapshot(snapshot: unknown): HumanGateAutonomy {
  const parsed = executionPolicySchema.safeParse(snapshot);

  return parsed.success ? expandExecutionPolicy(parsed.data).humanGate : "stop";
}

// Resolve just the on-stuck axis (B3) from a run's execution_policy snapshot.
// Fail closed: a null / absent / malformed snapshot resolves to `escalate` —
// a corrupt policy must NEVER silently ship or notify-without-escalating.
export function onStuckFromSnapshot(snapshot: unknown): OnStuckAction {
  const parsed = executionPolicySchema.safeParse(snapshot);

  return parsed.success
    ? expandExecutionPolicy(parsed.data).onStuck
    : "escalate";
}

// Resolve just the promotion axis (C1) from a run's execution_policy snapshot.
// Fail closed: a null / absent / malformed snapshot resolves to `manual` — a
// corrupt policy must NEVER silently auto-promote.
export function promotionFromSnapshot(snapshot: unknown): PromotionTrigger {
  const parsed = executionPolicySchema.safeParse(snapshot);

  return parsed.success
    ? expandExecutionPolicy(parsed.data).promotion
    : "manual";
}

// Resolve just the commit-policy axis (C2) from a run's execution_policy
// snapshot. Fail closed: a null / absent / malformed snapshot resolves to
// `keep_all` — a corrupt policy must NEVER silently rewrite run history.
export function commitsFromSnapshot(snapshot: unknown): CommitPolicy {
  const parsed = executionPolicySchema.safeParse(snapshot);

  return parsed.success
    ? expandExecutionPolicy(parsed.data).commits
    : "keep_all";
}

// Resolve just the dirty-resolution axis (C3) from a run's execution_policy
// snapshot. Fail closed: a null / absent / malformed snapshot resolves to `ask`
// — a corrupt policy must NEVER silently auto-commit or proceed on a dirty tree.
export function dirtyResolveFromSnapshot(snapshot: unknown): DirtyResolution {
  const parsed = executionPolicySchema.safeParse(snapshot);

  return parsed.success
    ? expandExecutionPolicy(parsed.data).dirtyResolve
    : "ask";
}

// B2/B3 decision matrix for a human gate (pure). The runner computes the policy
// axes + whether the node has a safe-default (forward, non-rework) decision +
// whether Group-A machine review passed (assertEvidenceReady), then dispatches:
//  - `pause`     — the normal HITL pause; `assign:false` is B3 notify_only
//                  (pause WITHOUT a human assignment — emit-and-don't-block).
//  - `auto_pass` — B2: machine review passed → resolve the gate with the
//                  safe-default decision, no human.
//  - `ship_with_warning` — B3: ship forward on the safe-default + a warning.
// `humanGate==="stop"` (supervised/assisted) always pauses with an assignment —
// the pre-B2 behavior. Under `auto_pass`, a not-ready / no-safe-default gate is
// "stuck" and routes per `onStuck` (default escalate ⇒ pause+assign).
export type HumanGateDisposition =
  | { action: "pause"; assign: boolean }
  | { action: "auto_pass" }
  | { action: "ship_with_warning" };

export function resolveHumanGateDisposition(args: {
  humanGate: HumanGateAutonomy;
  onStuck: OnStuckAction;
  hasSafeDefault: boolean;
  evidenceReady: boolean;
}): HumanGateDisposition {
  if (args.humanGate !== "auto_pass") return { action: "pause", assign: true };

  if (args.hasSafeDefault && args.evidenceReady) return { action: "auto_pass" };

  // Stuck (machine review not ready, or no safe default) → route per onStuck.
  if (args.onStuck === "ship_with_warning" && args.hasSafeDefault) {
    return { action: "ship_with_warning" };
  }
  if (args.onStuck === "notify_only") return { action: "pause", assign: false };

  // escalate (default), or ship_with_warning with no safe default to ship onto.
  return { action: "pause", assign: true };
}
