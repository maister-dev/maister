import type { RunStatus } from "@/lib/db/schema";

import { sql, type SQL } from "drizzle-orm";

// ADR-209: the one rule for "this Run needs someone" — the left rail's rows and
// its counter both come from it. Read-only; it never changes a status.

export type ActiveAttentionReason =
  | "executing"
  | "needs_input"
  | "being_edited"
  | "waiting_on_children"
  | "waiting_condition"
  | "awaiting_review"
  | "unpromoted_closed_task"
  | "recover_or_discard"
  | "failed";

export type ActiveAttentionInput = {
  // null = task-less Run (scratch); otherwise whether the task is still open.
  taskOpen: boolean | null;
  // No newer attempt of the same task and run kind exists.
  newestAttempt: boolean;
};

// A failure matters only while someone can still act on it: the newest attempt
// of an open task, or task-less work whose workspace is still retained.
const retryable =
  (reason: ActiveAttentionReason) =>
  (input: ActiveAttentionInput): ActiveAttentionReason | null =>
    input.taskOpen === null || (input.taskOpen && input.newestAttempt)
      ? reason
      : null;

const ATTENTION_BY_STATUS = {
  Pending: () => null,
  Running: () => "executing",
  NeedsInput: () => "needs_input",
  NeedsInputIdle: () => "needs_input",
  HumanWorking: () => "being_edited",
  WaitingOnChildren: () => "waiting_on_children",
  Waiting: () => "waiting_condition",
  Review: (input: ActiveAttentionInput) =>
    input.taskOpen === false ? "unpromoted_closed_task" : "awaiting_review",
  Crashed: retryable("recover_or_discard"),
  Failed: retryable("failed"),
  Done: () => null,
  Abandoned: () => null,
} satisfies Record<
  RunStatus,
  (input: ActiveAttentionInput) => ActiveAttentionReason | null
>;

export function activeAttentionReason(
  status: RunStatus,
  input: ActiveAttentionInput,
): ActiveAttentionReason | null {
  return ATTENTION_BY_STATUS[status](input);
}

/** Statuses that are members whatever their task or attempt. */
export const UNCONDITIONAL_ATTENTION_STATUSES = [
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
  "WaitingOnChildren",
  "Waiting",
  "Review",
] as const satisfies readonly RunStatus[];

/** Statuses that are members only while retryable (see `retryable`). */
export const RETRYABLE_ATTENTION_STATUSES = [
  "Crashed",
  "Failed",
] as const satisfies readonly RunStatus[];

/**
 * SQL twin of `activeAttentionReason(...) !== null` for a query that has the
 * Run as `runs` and its (optional) task as `tasks`. `taskOpenSql` and
 * `newestAttemptSql` are the exact inputs the classifier receives per row.
 */
export const taskOpenSql = sql<
  boolean | null
>`CASE WHEN "tasks"."id" IS NULL THEN NULL ELSE "tasks"."status" NOT IN ('Done','Abandoned') END`;

export const newestAttemptSql = sql<boolean>`NOT EXISTS (
  SELECT 1 FROM "runs" AS "newer_attempt"
  WHERE "runs"."task_id" IS NOT NULL
    AND "newer_attempt"."task_id" = "runs"."task_id"
    AND "newer_attempt"."run_kind" = "runs"."run_kind"
    AND ("newer_attempt"."started_at", "newer_attempt"."id") > ("runs"."started_at", "runs"."id")
)`;

export function activeAttentionPredicate(): SQL {
  const unconditional = sql.join(
    UNCONDITIONAL_ATTENTION_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  const retryableStatuses = sql.join(
    RETRYABLE_ATTENTION_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );

  return sql`("runs"."status" IN (${unconditional}) OR ("runs"."status" IN (${retryableStatuses}) AND ("tasks"."id" IS NULL OR (${taskOpenSql} AND ${newestAttemptSql}))))`;
}
