/**
 * Board stage derivation — pure mapping from domain state to display columns.
 *
 * WHY this is an approximation (6 design stages ≠ POC state machine):
 *
 * The product vision has six stages: Backlog → Prepare → InProduction →
 * OnReview → InDelivery → Done. The POC state machine has fewer real
 * stages: tasks have `status` (Backlog/InFlight/Done/Abandoned) and `stage`
 * (Backlog/Prepare), while runs have a richer `status` enum that drives the
 * execution axis.
 *
 * Two explicit approximations:
 *
 * 1. "InDelivery" has no real deploy/canary backend in the POC. We use
 *    `runStatus="Done" AND workspaceRemoved=false` as a proxy for "shipped
 *    but still in the recent shipping window." The worktree GC (7-day cron)
 *    clears it into "Done" automatically when `removedAt` is set.
 *
 * 2. "Prepare" has two sources: `task.stage="Prepare"` (the pre-launch spec
 *    phase) and `runStatus="Pending"` (queued, not yet running). These feel
 *    different conceptually but both mean "about to run," so they share the
 *    column.
 *
 * Precedence (highest wins):
 *   1. Terminal-failed run (Crashed/Failed/Abandoned) → Backlog (retry rule).
 *   2. Active run status (Pending/Running/NeedsInput/NeedsInputIdle/Review/Done).
 *   3. Task stage = Prepare.
 *   4. Task status = Done → Done.
 *   5. Default → Backlog.
 */

import type { Run, Task } from "@/lib/db/schema";

export type BoardColumn =
  | "Backlog"
  | "Prepare"
  | "InProduction"
  | "OnReview"
  | "InDelivery"
  | "Done";

export const BOARD_COLUMNS: readonly BoardColumn[] = [
  "Backlog",
  "Prepare",
  "InProduction",
  "OnReview",
  "InDelivery",
  "Done",
];

export type TaskStatus = Task["status"];
export type TaskStage = Task["stage"];
export type RunStatus = Run["status"];

export interface DeriveStageInput {
  taskStatus: TaskStatus;
  taskStage: TaskStage;
  runStatus: RunStatus | null;
  workspaceRemoved: boolean;
}

const TERMINAL_FAILED_STATUSES: ReadonlySet<RunStatus> = new Set([
  "Crashed",
  "Failed",
  "Abandoned",
]);

const IN_PRODUCTION_STATUSES: ReadonlySet<RunStatus> = new Set([
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
]);

export function deriveStage(input: DeriveStageInput): BoardColumn {
  const { taskStatus, taskStage, runStatus, workspaceRemoved } = input;

  // 1. Terminal-failed run → task auto-returns to Backlog (retry rule).
  if (runStatus !== null && TERMINAL_FAILED_STATUSES.has(runStatus)) {
    return "Backlog";
  }

  // 2. Active run status drives the column.
  if (runStatus !== null) {
    if (runStatus === "Pending") {
      return "Prepare";
    }

    if (IN_PRODUCTION_STATUSES.has(runStatus)) {
      return "InProduction";
    }

    if (runStatus === "Review") {
      return "OnReview";
    }

    if (runStatus === "Done") {
      // Worktree still present → shipping window (InDelivery approximation).
      // Worktree removed → fully delivered.
      return workspaceRemoved ? "Done" : "InDelivery";
    }
  }

  // 3. No active run — fall back to task-level state.

  // Pre-launch spec phase.
  if (taskStage === "Prepare") {
    return "Prepare";
  }

  // Task explicitly completed (terminal).
  if (taskStatus === "Done") {
    return "Done";
  }

  // Default: Backlog (covers taskStatus=Backlog, InFlight with no run yet,
  // and Abandoned task with no surviving run record).
  return "Backlog";
}

/**
 * Returns the i18n key for a board column under the `board` namespace,
 * matching keys declared in `web/messages/en.json`.
 */
export function columnLabelKey(col: BoardColumn): string {
  switch (col) {
    case "Backlog":
      return "board.colBacklog";
    case "Prepare":
      return "board.colPrepare";
    case "InProduction":
      return "board.colProduction";
    case "OnReview":
      return "board.colReview";
    case "InDelivery":
      return "board.colDelivery";
    case "Done":
      return "board.colDone";
  }
}
