// Shared types for the Evaluation Lab domain (M46, ADR-142..145). Kept free of
// `server-only` so both schema.ts (server) and client DTO mappers can import the
// unions without pulling server modules into the client bundle.

// Persisted Study lifecycle. Readiness (>= 2 eligible participants) and the
// active-evaluation count are DERIVED facets, never persisted states (D4).
export const EVALUATION_STUDY_STATUSES = [
  "draft",
  "open",
  "decided",
  "archived",
] as const;
export type EvaluationStudyStatus = (typeof EVALUATION_STUDY_STATUSES)[number];

// Immutable participant provenance (D3). `observed` = an existing Run selected
// for comparison; never gains launch semantics/holds. `launched` = created from
// a Study recipe with an owning launch lineage + forced promotion hold.
export const EVALUATION_PARTICIPANT_SOURCES = ["observed", "launched"] as const;
export type EvaluationParticipantSource =
  (typeof EVALUATION_PARTICIPANT_SOURCES)[number];

// Why a launched participant was created (mirrors experiment launch reasons plus
// the evaluation-specific reasons). Null for observed participants.
export const EVALUATION_LAUNCH_REASONS = [
  "initial",
  "manual_relaunch",
  "replicate",
] as const;
export type EvaluationLaunchReason = (typeof EVALUATION_LAUNCH_REASONS)[number];

// A copied snapshot of the source Run's identity/provenance, stored on the
// participant so its history survives Run deletion (D3). Opaque, bounded — never
// a private path, session id, adapter env, or credential.
export interface EvaluationRunIdentitySnapshot {
  runId: string;
  taskId: string;
  flowRefId?: string;
  flowRevisionId?: string;
  status?: string;
  baseCommit?: string;
  branchTipSha?: string;
  capturedAt: string;
}

// An immutable Evaluation Recipe definition. M46 stores legacy variant configs
// (from the Experiment migration); the fully typed controlled recipe is M47
// (ADR-146). Treated as opaque immutable JSON keyed by a content digest.
export type EvaluationRecipeDefinition = Record<string, unknown>;

// --- Platform configuration (D6, D8; 0108) ---------------------------------

// A package-derived Method revision's mutable activation state. Health
// (ready | degraded | incompatible) is DERIVED from trust + engine compat at
// read time, never persisted (D8).
export const EVALUATION_METHOD_ACTIVATIONS = ["enabled", "disabled"] as const;
export type EvaluationMethodActivation =
  (typeof EVALUATION_METHOD_ACTIVATIONS)[number];

export const EVALUATION_METHOD_HEALTHS = [
  "ready",
  "degraded",
  "incompatible",
] as const;
export type EvaluationMethodHealth = (typeof EVALUATION_METHOD_HEALTHS)[number];

// Engine compat range copied from the method definition at projection time.
export interface EvaluationMethodCompat {
  engineMin: string;
  engineMax?: string | null;
}

// One logical judge role → package-qualified platform agent + runner/model
// intent. M46 binds package-qualified platform agents ONLY (D8); project-linked
// bindings are deferred. `agentId` is `agents.id` (`<packageName>:<stem>`).
export interface EvaluationPanelRoleBinding {
  role: string;
  agentId: string;
  runnerId?: string | null;
  // Typed model/provider/effort intent when no concrete runner is pinned.
  runnerIntent?: Record<string, unknown> | null;
}

// The non-binding panel policy knobs (D8). `maxParallelAttempts` is hard-capped
// at MAISTER_MAX_CONCURRENT_AGENTS - 1 by the service so one agent slot stays
// free (D12); the column stores the operator's requested value.
export interface EvaluationPanelPolicy {
  attempts: number;
  maxParallelAttempts: number;
  quorum: number;
  timeoutMs: number;
  maxRetries: number;
  budgets?: { tokens?: number | null; costUsd?: number | null } | null;
  blindLabels: boolean;
  randomizeOrder: boolean;
  allowedMcps: string[];
  poisonPolicy?: Record<string, unknown> | null;
}

// --- Evaluation Execution lifecycle (D4; 0109) -----------------------------

// Persisted Evaluation Execution status. Exact allow-list transitions with
// CAS/version guards (D4). Failed/Partial/Completed/Cancelled are terminal;
// retry never re-enters a terminal row (creates a new execution, retry_of).
export const EVALUATION_EXECUTION_STATUSES = [
  "queued",
  "capturing",
  "checking",
  "judging",
  "aggregating",
  "review_required",
  "cancelling",
  "completed",
  "partial",
  "failed",
  "cancelled",
] as const;
export type EvaluationExecutionStatus =
  (typeof EVALUATION_EXECUTION_STATUSES)[number];

export const EVALUATION_EXECUTION_TERMINAL_STATUSES = [
  "completed",
  "partial",
  "failed",
  "cancelled",
] as const;

// Immutable evidence snapshot lifecycle (D5, D9). A `sealed` snapshot may be
// attached to multiple executions when digests match; deletion is two-stage.
export const EVALUATION_SNAPSHOT_STATUSES = [
  "preparing",
  "sealed",
  "pending_delete",
  "deleted",
] as const;
export type EvaluationSnapshotStatus =
  (typeof EVALUATION_SNAPSHOT_STATUSES)[number];

// Objective check statuses (D11). Nonterminal/absence statuses require a
// reason; judges may reference facts but never infer PASS from source shape.
export const EVALUATION_OBJECTIVE_CHECK_STATUSES = [
  "queued",
  "running",
  "passed",
  "failed",
  "error",
  "cancelled",
  "not_run",
  "unavailable",
] as const;
export type EvaluationObjectiveCheckStatus =
  (typeof EVALUATION_OBJECTIVE_CHECK_STATUSES)[number];

// Objective metric result status — missing is explicit, never zero (D11, D18).
export const EVALUATION_METRIC_STATUSES = [
  "measured",
  "unavailable",
  "not_run",
] as const;
export type EvaluationMetricStatus =
  (typeof EVALUATION_METRIC_STATUSES)[number];

// Judge attempt lifecycle (D12). `completed` seals a valid result; `invalid`
// is a terminal invalid attempt (may spawn a bounded repair child).
export const EVALUATION_JUDGE_ATTEMPT_STATUSES = [
  "queued",
  "running",
  "completed",
  "invalid",
  "timed_out",
  "cancelled",
  "error",
] as const;
export type EvaluationJudgeAttemptStatus =
  (typeof EVALUATION_JUDGE_ATTEMPT_STATUSES)[number];

// Per-criterion result state (D12). Missing criteria never become numeric
// zero; a null score pairs with insufficient_evidence | not_applicable.
export const EVALUATION_CRITERION_STATES = [
  "scored",
  "insufficient_evidence",
  "not_applicable",
] as const;
export type EvaluationCriterionState =
  (typeof EVALUATION_CRITERION_STATES)[number];

// Disagreement/escalation review ledger (D13).
export const EVALUATION_REVIEW_KINDS = ["disagreement", "escalation"] as const;
export type EvaluationReviewKind = (typeof EVALUATION_REVIEW_KINDS)[number];

export const EVALUATION_REVIEW_STATUSES = ["required", "resolved"] as const;
export type EvaluationReviewStatus =
  (typeof EVALUATION_REVIEW_STATUSES)[number];

// Append-only human verdict outcome (D14).
export const EVALUATION_VERDICT_OUTCOMES = [
  "winner",
  "tie",
  "inconclusive",
] as const;
export type EvaluationVerdictOutcome =
  (typeof EVALUATION_VERDICT_OUTCOMES)[number];

// Evidence item coverage class (D9). `uncommitted_not_captured` records that an
// active Run's dirty working tree was intentionally not read (commit-anchored).
export const EVALUATION_COVERAGE_CLASSES = [
  "captured",
  "truncated",
  "redacted",
  "uncommitted_not_captured",
  "unavailable",
] as const;
export type EvaluationCoverageClass =
  (typeof EVALUATION_COVERAGE_CLASSES)[number];
