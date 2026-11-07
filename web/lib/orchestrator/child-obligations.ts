import "server-only";

import type { SQL, SQLWrapper } from "drizzle-orm";
import type { Db } from "@/lib/execution-host/db";
import type { ChildLaunchReceipt } from "./child-launch-context";

import { and, eq, inArray, sql } from "drizzle-orm";

import { coordinatorChildLaunchContextSchema } from "./child-launch-context";

import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";
import { readPromptRequest } from "@/lib/execution-host/command-request";
import {
  executionCommands,
  executionHosts,
  runs,
  taskLaunchIntents,
} from "@/lib/db/schema";
import { SETTLED_RUN_STATUSES } from "@/lib/runs/run-status-sets";

/** Bound Runs own their completion state; a retained original binding never becomes a new request. */
export function unboundExecutionChildPredicate(
  parentRunId: string | SQLWrapper,
): SQL {
  return sql`child_intent.basis->>'kind'='execution_child'
    AND child_intent.basis->'parent'->>'parentRunId'=${parentRunId}
    AND child_intent.project_id=(SELECT parent_owner.project_id FROM runs parent_owner WHERE parent_owner.id=${parentRunId})
    AND child_intent.run_id IS NULL AND child_intent.original_run_id IS NULL`;
}

/** Completion obligations deliberately differ from the live fanout capacity predicate. */
export function pendingChildObligationPredicate(
  parentRunId: string | SQLWrapper,
): SQL<boolean> {
  return sql<boolean>`(EXISTS(SELECT 1 FROM runs child_run
      WHERE child_run.parent_run_id=${parentRunId}
      AND child_run.status NOT IN (${sql.join(
        SETTLED_RUN_STATUSES.map((status) => sql`${status}`),
        sql`, `,
      )}))
    OR EXISTS(SELECT 1 FROM task_launch_intents child_intent
      WHERE ${unboundExecutionChildPredicate(parentRunId)}
      AND child_intent.state IN ('queued','preparing','held')))`;
}

export async function childObligationCounts(
  db: Db,
  parentRunId: string,
): Promise<Readonly<{ total: number; pending: number }>> {
  const result = await db.execute<{ total: number; pending: number }>(sql`SELECT
    ((SELECT count(*) FROM runs WHERE parent_run_id=${parentRunId})+
      (SELECT count(*) FROM task_launch_intents child_intent WHERE ${unboundExecutionChildPredicate(parentRunId)}))::int AS total,
    ((SELECT count(*) FROM runs WHERE parent_run_id=${parentRunId}
      AND status NOT IN (${sql.join(
        SETTLED_RUN_STATUSES.map((status) => sql`${status}`),
        sql`, `,
      )}))+
      (SELECT count(*) FROM task_launch_intents child_intent WHERE ${unboundExecutionChildPredicate(parentRunId)}
        AND state IN ('queued','preparing','held')))::int AS pending`);

  return result.rows[0];
}

/** Content-free receipts let a coordinator diagnose admission failure before a child Run exists. */
export async function unboundChildLaunchReceipts(
  db: Db,
  parentRunId: string,
): Promise<ChildLaunchReceipt[]> {
  const result =
    await db.execute<ChildLaunchReceipt>(sql`WITH child_receipts AS MATERIALIZED (
    SELECT child_intent.id AS "intentId",child_intent.task_id AS "taskId",child_intent.state,
      child_intent.state_version AS "stateVersion",child_intent.reason,child_intent.accepted_at AS "acceptedAt",
      CASE WHEN child_intent.state IN ('failed','cancelled') THEN 0 ELSE 1 END AS category
    FROM task_launch_intents child_intent
    WHERE ${unboundExecutionChildPredicate(parentRunId)}
      AND (child_intent.state IN ('queued','preparing','held')
        OR child_intent.state IN ('failed','cancelled')
          AND child_intent.parent_observed_version IS DISTINCT FROM child_intent.state_version)
  )
  SELECT "intentId","taskId",state,"stateVersion",reason FROM (
    (SELECT * FROM child_receipts WHERE category=0 ORDER BY "acceptedAt","intentId" LIMIT 32)
    UNION ALL
    (SELECT * FROM child_receipts WHERE category=1 ORDER BY "acceptedAt","intentId" LIMIT 32)
  ) bounded_receipts ORDER BY category,"acceptedAt","intentId"`);

  return result.rows.map((receipt) => ({
    ...receipt,
    reason:
      receipt.reason === null || /^[a-z][a-z0-9_]{0,127}$/.test(receipt.reason)
        ? receipt.reason
        : "launch_attention_required",
  }));
}

/** A failed pre-run request requires one coordinator decision, including after a manager restart. */
export function unobservedChildOutcomePredicate(
  parentRunId: string | SQLWrapper,
): SQL<boolean> {
  return sql<boolean>`EXISTS(SELECT 1 FROM task_launch_intents child_intent
    WHERE ${unboundExecutionChildPredicate(parentRunId)}
    AND child_intent.state IN ('failed','cancelled')
    AND child_intent.parent_observed_version IS DISTINCT FROM child_intent.state_version)`;
}

export async function hasUnobservedChildOutcome(
  db: Db,
  parentRunId: string,
): Promise<boolean> {
  const result = await db.execute<{ unseen: boolean }>(
    sql`SELECT ${unobservedChildOutcomePredicate(parentRunId)} AS unseen`,
  );

  return result.rows[0].unseen;
}

/** The exact observed receipt is acknowledged without mutating the accepted request or its state revision. */
async function observeChildLaunchOutcomes(
  db: Db,
  parentRunId: string,
  receipts: readonly ChildLaunchReceipt[],
): Promise<void> {
  const terminal = receipts.filter(
    (receipt) => receipt.state === "failed" || receipt.state === "cancelled",
  );

  if (terminal.length === 0) return;
  await db.transaction(async (tx) => {
    const [parent] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, parentRunId))
      .for("update");

    if (!parent) return;
    for (const receipt of terminal)
      await tx
        .update(taskLaunchIntents)
        .set({ parentObservedVersion: receipt.stateVersion })
        .where(
          and(
            eq(taskLaunchIntents.id, receipt.intentId),
            eq(taskLaunchIntents.stateVersion, receipt.stateVersion),
            eq(taskLaunchIntents.state, receipt.state),
            sql`${taskLaunchIntents.basis}->>'kind'='execution_child' AND ${taskLaunchIntents.basis}->'parent'->>'parentRunId'=${parentRunId}`,
            sql`${taskLaunchIntents.projectId}=(SELECT parent_owner.project_id FROM runs parent_owner WHERE parent_owner.id=${parentRunId})`,
            sql`${taskLaunchIntents.runId} IS NULL AND ${taskLaunchIntents.originalRunId} IS NULL`,
          ),
        );
  });
}

/** A replay may use an older frozen prompt. Never acknowledge fresh context it did not contain. */
export async function observeCompletedChildLaunchPrompt(
  db: Db,
  input: Readonly<{
    parentRunId: string;
    nodeAttemptId: string;
    promptOrdinal: number;
  }>,
): Promise<void> {
  const [stored] = await db
    .select({ command: executionCommands, hostKey: executionHosts.hostKey })
    .from(executionCommands)
    .innerJoin(
      executionHosts,
      eq(executionHosts.id, executionCommands.executionHostId),
    )
    .where(
      and(
        eq(executionCommands.runId, input.parentRunId),
        inArray(executionCommands.logicalOperationKey, [
          `flow_node_attempt:node:${input.nodeAttemptId}:${input.promptOrdinal}`,
          `flow_node_attempt:permission_resume:${input.nodeAttemptId}:${input.promptOrdinal}`,
        ]),
        eq(executionCommands.state, "succeeded"),
        eq(executionCommands.applicationState, "applied"),
      ),
    );

  if (!stored) return;
  readPromptRequest(stored.command, stored.hostKey);
  if (stored.command.coordinatorChildLaunchContext === null) return;
  const context = coordinatorChildLaunchContextSchema.parse(
    stored.command.coordinatorChildLaunchContext,
  );

  if (
    context.requestSha256 !== stored.command.requestSha256 ||
    context.nodeAttemptId !== input.nodeAttemptId ||
    context.promptOrdinal !== input.promptOrdinal ||
    stored.command.ownerKind !== "flow_node_attempt" ||
    !(
      stored.command.ownerRef &&
      "nodeAttemptId" in stored.command.ownerRef &&
      stored.command.ownerRef.nodeAttemptId === input.nodeAttemptId
    )
  )
    throw new PromptOwnerInvariantError("coordinator_child_context_binding");
  await observeChildLaunchOutcomes(db, input.parentRunId, context.receipts);
}
