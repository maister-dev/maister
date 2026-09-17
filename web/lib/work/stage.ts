/**
 * Derived work-stage vocabulary (ADR-170).
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
  /**
   * `taskStatus` decides the NO-RUN case before triage does: a terminal task
   * (`Done`/`Abandoned`) is settled whether or not it ever launched.
   *
   * `taskStage` and `runKind` are read by no branch today. They are part of the
   * signature ADR-170 D1 fixes normatively, and they stay because the run axis
   * dominates whenever a run exists — a future divergence (a `scratch` run that
   * must not read as `Executing`) lands as a branch here rather than as a new
   * parameter threaded through both call sites.
   */
  taskStatus: Task["status"];
  taskStage: Task["stage"];
  triageStatus: Task["triageStatus"];
  runStatus: RunStatusValue | null;
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

// A task that is over is over, whether or not it ever launched a run.
// `abandonUnlaunchedTasks` (the orchestrator cascade) sets `Abandoned` with
// `notExists(runs for this task)` in its WHERE — so a run-LESS terminal task is
// not a theoretical shape, it is the only shape that path produces. Reading
// such a row through `triageStatus` alone rendered it as live backlog work
// (`Triage`/`Held`/`Ready`) with working next-action links, and dropped it from
// the `Abandoned` filter it belongs to.
const STAGE_BY_TERMINAL_TASK_STATUS = {
  Done: "Promoted",
  Abandoned: "Abandoned",
} as const satisfies Partial<Record<Task["status"], WorkStage>>;

function terminalTaskStage(status: Task["status"]): WorkStage | null {
  return status === "Done" || status === "Abandoned"
    ? STAGE_BY_TERMINAL_TASK_STATUS[status]
    : null;
}

function stageOf(input: DeriveWorkStageInput): WorkStage {
  const { runStatus, workspaceRemoved, triageStatus, taskStatus } = input;

  if (runStatus === null) {
    return (
      terminalTaskStage(taskStatus) ??
      STAGE_BY_TRIAGE[triageStatus ?? "untriaged"]
    );
  }

  // A user-removed workspace turns a parked Review/Crashed result into
  // historical evidence, so the task must not stay in a lane it cannot be
  // relaunched from. Mirrors the board's existing rule.
  if (workspaceRemoved && (runStatus === "Review" || runStatus === "Crashed")) {
    return "Ready";
  }

  return STAGE_BY_RUN_STATUS[runStatus];
}

// ADR-170 D3: `promotion_state` carries five values, of which only 'none' and
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

/**
 * The three-way partition of `WORK_STAGES` the Desk reads (ADR-172 D1).
 *
 * "Work in flight" is a launched run that has not settled: the stages between
 * `Queued` and `Crashed`. `Triage`/`Held`/`Ready` are work that has not
 * started; `Promoted`/`Abandoned` are work that is over.
 *
 * The lists are spelled out rather than derived by subtraction so an
 * ELEVENTH stage lands in none of them and `UT-STG-11` fails. Either default
 * — silently in flight, or silently invisible — is a bug nobody notices.
 */
export const WORK_BACKLOG_STAGES = [
  "Triage",
  "Held",
  "Ready",
] as const satisfies readonly WorkStage[];

export const WORK_IN_FLIGHT_STAGES = [
  "Queued",
  "Executing",
  "WaitingOnHuman",
  "Review",
  "Crashed",
] as const satisfies readonly WorkStage[];

export const WORK_SETTLED_STAGES = [
  "Promoted",
  "Abandoned",
] as const satisfies readonly WorkStage[];

export type WorkInFlightStage = (typeof WORK_IN_FLIGHT_STAGES)[number];

// A type predicate rather than a bare boolean: callers that partition rows by
// this need the narrowed stage to index an in-flight-keyed map without a cast.
export function isWorkInFlight(stage: WorkStage): stage is WorkInFlightStage {
  return (WORK_IN_FLIGHT_STAGES as readonly WorkStage[]).includes(stage);
}
