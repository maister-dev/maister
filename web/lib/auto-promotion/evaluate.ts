import pino from "pino";

import { classifyDiff } from "./classify";
import { resolveAutoPromotionConfig } from "./config";
import { checkDepsDiff } from "./deps-check";
import { autoPromotionEnabledFromEnv } from "./config";
import type { EffectiveLaneMode, LaneClass } from "./config";
import type { DepsFile } from "./deps-check";
import type { PromotionHold } from "./types";
import { checksFromSnapshot, promotionFromSnapshot } from "@/lib/runs/execution-policy";
import type { DiffChangeStatEntry } from "@/lib/worktree";

// ADR-126 §4.4: the ONE shared, fail-closed eligibility predicate. The sweep and
// the run-detail panel both call this — the returned DTO IS the sweep decision,
// so their verdicts are byte-identical for identical state (INV-10).

const log = pino({
  name: "auto-promote.evaluate",
  level: process.env.LOG_LEVEL ?? "info",
});

// Const arrays (not just a union) so the i18n closure test can iterate every
// reason and the type can never drift from the runtime list.
export const INELIGIBLE_REASONS = [
  "deny_list",
  "no_lane",
  "ambiguous_lane",
  "empty_diff",
  "deps_content",
  "checks_not_strict",
  "pending_hitl",
  "readiness_not_green",
  "external_check_missing",
  "external_check_not_passed",
  "no_review_anchor",
  "grace_pending",
  "config_invalid",
] as const;

export type IneligibleReason = (typeof INELIGIBLE_REASONS)[number];

export const NOT_APPLICABLE_REASONS = [
  "status",
  "run_kind",
  "no_task",
  "orchestrator_child",
  "shared_workspace",
  "auto_on_ready",
] as const;

export type NotApplicableReason = (typeof NOT_APPLICABLE_REASONS)[number];

export type AutoPromotionEvaluation =
  | {
      verdict: "eligible";
      lane: LaneClass;
      mode?: EffectiveLaneMode;
      reviewEnteredAt: string;
      eligibleAt: string;
    }
  | { verdict: "held"; hold: PromotionHold }
  | {
      verdict: "ineligible";
      reason: IneligibleReason;
      files?: string[];
      detail?: string;
      eligibleAt?: string;
    }
  | { verdict: "disabled"; scope: "platform" | "project" }
  | { verdict: "not_applicable"; reason: NotApplicableReason };

// The external_check gate state: `not_declared` (id absent from the compiled
// FlowGraph — misconfig) vs `declared_not_passed` (present but no passing row).
export type ExternalCheckState = "passed" | "declared_not_passed" | "not_declared";

// The subset of the run row the predicate needs (terms 3-9, 12, 16).
export interface AutoPromotionRunView {
  id: string;
  projectId: string;
  status: string;
  runKind: string;
  taskId: string | null;
  parentRunId: string | null;
  workspaceMode: string | null;
  deliveryPolicySnapshot: { trigger?: string | null } | null;
  executionPolicy: unknown;
  promotionHold: PromotionHold | null;
  reviewEnteredAt: Date | null;
}

// Async readers injected so unit tests can drive each term in isolation and the
// sweep/route can back them with real DB / git access.
export interface AutoPromotionReaders {
  hasOpenHitl(): Promise<boolean>;
  readinessGreen(): Promise<boolean>;
  externalCheck(gateId: string): Promise<ExternalCheckState>;
  readDepsFiles(files: DiffChangeStatEntry[]): Promise<DepsFile[]>;
}

export interface EvaluateAutoPromotionInput {
  run: AutoPromotionRunView;
  project: { id: string; autoPromotion?: unknown };
  files: DiffChangeStatEntry[];
  now: Date;
  readers: AutoPromotionReaders;
}

function ineligible(
  reason: IneligibleReason,
  extra?: { files?: string[]; detail?: string; eligibleAt?: string },
): AutoPromotionEvaluation {
  return { verdict: "ineligible", reason, ...extra };
}

function isAutoOnReady(run: AutoPromotionRunView): boolean {
  return (
    run.deliveryPolicySnapshot?.trigger === "auto_on_ready" ||
    promotionFromSnapshot(run.executionPolicy) === "auto_on_ready"
  );
}

export async function evaluateAutoPromotion(
  input: EvaluateAutoPromotionInput,
): Promise<AutoPromotionEvaluation> {
  const { run, project, files, now, readers } = input;

  // Term 1: platform env kill switch.
  if (!autoPromotionEnabledFromEnv()) {
    return { verdict: "disabled", scope: "platform" };
  }

  // Term 2: project master toggle (malformed ⇒ config_invalid, distinct from off).
  const resolved = resolveAutoPromotionConfig(project);

  if (resolved.source === "invalid") return ineligible("config_invalid");
  if (!resolved.config.enabled) return { verdict: "disabled", scope: "project" };

  // Terms 3-7: structural non-candidacy (permanent for this run — not_applicable,
  // so the panel never tells a user to "fix" a scratch/child/shared run).
  if (run.status !== "Review") {
    return { verdict: "not_applicable", reason: "status" };
  }
  if (run.runKind !== "flow") {
    return { verdict: "not_applicable", reason: "run_kind" };
  }
  if (!run.taskId) {
    return { verdict: "not_applicable", reason: "no_task" };
  }
  if (run.parentRunId) {
    return { verdict: "not_applicable", reason: "orchestrator_child" };
  }
  if (run.workspaceMode === "shared") {
    return { verdict: "not_applicable", reason: "shared_workspace" };
  }

  // Term 8: already auto-delivering (either OR-combined knob) — the existing
  // autopilot owns it.
  if (isAutoOnReady(run)) {
    return { verdict: "not_applicable", reason: "auto_on_ready" };
  }

  // Term 9: explicit hold.
  if (run.promotionHold) return { verdict: "held", hold: run.promotionHold };

  // Terms 10-11: deny-list first, then exactly-one-lane classification.
  const cls = classifyDiff(files, resolved.config);

  if (cls.kind === "denied") return ineligible("deny_list", { files: cls.files });
  if (cls.kind === "empty_diff") return ineligible("empty_diff");
  if (cls.kind === "no_lane") return ineligible("no_lane", { files: cls.files });
  if (cls.kind === "ambiguous_lane") {
    return ineligible("ambiguous_lane", { files: cls.files });
  }

  const lane = resolved.config.lanes.find(
    (l) => l.enabled && l.class === cls.lane,
  );

  // Unreachable (classify only returns a lane that matched an enabled lane), but
  // fail-closed if the invariant is ever violated.
  if (!lane) return ineligible("no_lane", { files: files.map((f) => f.path) });

  // Term 11 (deps content): a deps lane needs the manifest/lockfile gate.
  if (cls.lane === "deps") {
    const depsFiles = await readers.readDepsFiles(files);
    const depsResult = checkDepsDiff(depsFiles);

    if (!depsResult.ok) {
      return ineligible("deps_content", { detail: depsResult.detail });
    }
  }

  // Term 12: no-blind-ship — relaxed/skip checks never auto-promote.
  if (checksFromSnapshot(run.executionPolicy) !== "strict") {
    return ineligible("checks_not_strict");
  }

  // Term 13: no open HITL (belt over the status=Review term).
  if (await readers.hasOpenHitl()) return ineligible("pending_hitl");

  // Term 14: readiness green (the same classifier promoteRun re-asserts).
  if (!(await readers.readinessGreen())) {
    return ineligible("readiness_not_green");
  }

  // Term 15: lane-required external check.
  if (lane.requireExternalCheckId) {
    const state = await readers.externalCheck(lane.requireExternalCheckId);

    if (state === "not_declared") return ineligible("external_check_missing");
    if (state !== "passed") return ineligible("external_check_not_passed");
  }

  // Term 16: grace elapsed since the review anchor (runs.review_entered_at).
  if (!run.reviewEnteredAt) return ineligible("no_review_anchor");

  const eligibleAt = new Date(
    run.reviewEnteredAt.getTime() + lane.delayMinutes * 60_000,
  );

  if (now < eligibleAt) {
    return ineligible("grace_pending", { eligibleAt: eligibleAt.toISOString() });
  }

  log.debug(
    { runId: run.id, lane: cls.lane },
    "auto-promotion evaluated eligible",
  );

  return {
    verdict: "eligible",
    lane: cls.lane,
    mode: lane.mode,
    reviewEnteredAt: run.reviewEnteredAt.toISOString(),
    eligibleAt: eligibleAt.toISOString(),
  };
}
