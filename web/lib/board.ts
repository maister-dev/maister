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
 *   1. Crashed run → Crashed (its own column; owes recover/discard, not a
 *      silent retry — M19).
 *   2. Terminal-failed run (Failed/Abandoned) → Backlog (retry rule).
 *   3. Active run status (Pending/Running/NeedsInput/NeedsInputIdle/Review/Done).
 *   4. Task stage = Prepare.
 *   5. Task status = Done → Done.
 *   6. Default → Backlog.
 */

import type { Run, Task } from "@/lib/db/schema";

export type BoardColumn =
  | "Backlog"
  | "Prepare"
  | "InProduction"
  | "OnReview"
  | "InDelivery"
  | "Crashed"
  | "Done";

export const BOARD_COLUMNS: readonly BoardColumn[] = [
  "Backlog",
  "Prepare",
  "InProduction",
  "OnReview",
  "InDelivery",
  "Crashed",
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
  "Failed",
  "Abandoned",
]);

const IN_PRODUCTION_STATUSES: ReadonlySet<RunStatus> = new Set([
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  // M11b (ADR-030): a claimed run (manual takeover) holds a worktree and a
  // concurrency slot — it stays in the in-flight bucket like Running/NeedsInput.
  "HumanWorking",
]);

export function deriveStage(input: DeriveStageInput): BoardColumn {
  const { taskStatus, taskStage, runStatus, workspaceRemoved } = input;

  // 1. Crashed run → its own column (owes recover/discard, M19). Checked
  // BEFORE the terminal-failed Backlog rule so it does not silently retry.
  if (runStatus === "Crashed") {
    return "Crashed";
  }

  // 2. Terminal-failed run (Failed/Abandoned) → task auto-returns to Backlog
  // (retry rule).
  if (runStatus !== null && TERMINAL_FAILED_STATUSES.has(runStatus)) {
    return "Backlog";
  }

  // 3. Active run status drives the column.
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

  // 4. No active run — fall back to task-level state.

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
    case "Crashed":
      return "board.colCrashed";
    case "Done":
      return "board.colDone";
  }
}

// The recover/discard affordance for a board card (M19). A DTO-projected enum
// derived from `acpSessionId` presence — the raw session id NEVER reaches the
// client. `recover` when a checkpoint handle survives, else `discard`; null on
// every non-Crashed or non-flow card.
export type CrashAction = "recover" | "discard";

export function crashActionFor(input: {
  runKind: Run["runKind"];
  runStatus: RunStatus | null;
  acpSessionId: string | null;
}): CrashAction | null {
  if (input.runKind !== "flow" || input.runStatus !== "Crashed") return null;

  return input.acpSessionId !== null ? "recover" : "discard";
}
