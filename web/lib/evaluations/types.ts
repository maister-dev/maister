// Shared types for the Evaluation Lab domain (M46, ADR-139..142). Kept free of
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
// (ADR-143). Treated as opaque immutable JSON keyed by a content digest.
export type EvaluationRecipeDefinition = Record<string, unknown>;
