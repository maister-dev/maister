/**
 * Derived work-stage vocabulary (ADR-169).
 *
 * A fourth "stage" vocabulary, deliberately separate from the three that
 * already exist — the persisted `tasks.stage` column, its `TaskStage` alias,
 * and `deriveStage() -> BoardColumn`. `BoardColumn` is a per-project Kanban
 * lane; this answers "where is this piece of work" comparably ACROSS projects
 * and for work that has never launched a run.
 *
 * Pure by contract (STG-02): no database handle, no clock, no `server-only`.
 * Nothing here is ever persisted (STG-07).
 */

import type { Run, Task } from "@/lib/db/schema";
import type { RunStatusValue } from "@/lib/runs/run-status-values";

export const WORK_STAGES = [
  "Triage",
  "Held",
  "Ready",
  "Queued",
  "Executing",
  "WaitingOnHuman",
  "Review",
  "Crashed",
  "Promoted",
  "Abandoned",
] as const;

export type WorkStage = (typeof WORK_STAGES)[number];

export type PromotedKind = "merge" | "result";

export interface WorkProgress {
  done: number;
  total: number;
}

export interface DeriveWorkStageInput {
  taskStatus: Task["status"];
  taskStage: Task["stage"];
  triageStatus: Task["triageStatus"];
  runStatus: RunStatusValue | null;
  // Part of the input signature ADR-169 D1 fixes normatively, though no branch
  // reads it today: the run-status axis already separates the kinds that differ.
  runKind: Run["runKind"] | null;
  promotionState: string | null;
  workspaceRemoved: boolean;
  blockingRelationCount: number;
  progress: WorkProgress | null;
}

export interface WorkStageResult {
  stage: WorkStage;
  blocked: boolean;
  progress: WorkProgress | null;
  promotedKind: PromotedKind | null;
}

// The exhaustive axis (STG-01). `satisfies Record<RunStatusValue, WorkStage>`
// makes a twelfth run status a COMPILE error here rather than a silently
// mis-rendered row on three surfaces.
const STAGE_BY_RUN_STATUS = {
  Pending: "Queued",
  Running: "Executing",
  NeedsInput: "WaitingOnHuman",
  NeedsInputIdle: "WaitingOnHuman",
  HumanWorking: "WaitingOnHuman",
  // A parked orchestrator is still executing; the board buckets it the same way.
  WaitingOnChildren: "Executing",
  Review: "Review",
  Crashed: "Crashed",
  Done: "Promoted",
  Abandoned: "Abandoned",
  // Failed returns the task to a relaunchable lane; Crashed is the exception,
  // because it owes an explicit recover/discard decision first.
  Failed: "Ready",
} as const satisfies Record<RunStatusValue, WorkStage>;

const STAGE_BY_TRIAGE = {
  untriaged: "Triage",
  flagged: "Held",
  triaged: "Ready",
} as const satisfies Record<
  NonNullable<Task["triageStatus"]> | "untriaged",
  WorkStage
>;

function stageOf(input: DeriveWorkStageInput): WorkStage {
  const { runStatus, workspaceRemoved, triageStatus } = input;

  if (runStatus === null) return STAGE_BY_TRIAGE[triageStatus ?? "untriaged"];

  // A user-removed workspace turns a parked Review/Crashed result into
  // historical evidence, so the task must not stay in a lane it cannot be
  // relaunched from. Mirrors the board's existing rule.
  if (workspaceRemoved && (runStatus === "Review" || runStatus === "Crashed")) {
    return "Ready";
  }

  return STAGE_BY_RUN_STATUS[runStatus];
}

// ADR-169 D3: `promotion_state` carries five values, of which only 'none' and
// 'done' are reachable beside a Done run. Any non-'none' state means a
// promotion path was engaged, so this stays total without a five-way branch.
function promotedKindOf(promotionState: string | null): PromotedKind {
  return promotionState === "none" ? "result" : "merge";
}

export function deriveWorkStage(input: DeriveWorkStageInput): WorkStageResult {
  const stage = stageOf(input);

  return {
    stage,
    // STG-05: an attribute beside the stage, never a member of it.
    blocked: input.blockingRelationCount > 0,
    // k/N describes a graph that is running; it is meaningless anywhere else.
    progress: stage === "Executing" ? input.progress : null,
    promotedKind:
      stage === "Promoted" ? promotedKindOf(input.promotionState) : null,
  };
}
