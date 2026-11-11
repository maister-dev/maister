import "server-only";

import type { Run } from "@/lib/db/schema";
import type { Db } from "@/lib/execution-host/db";
import type {
  BudgetScope,
  BudgetTermination,
} from "@/lib/runs/execution-policy";

import { randomUUID } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";
import pino from "pino";

import { FLOW_NODE_ATTEMPT_VARIANTS } from "@/lib/execution-host/prompt-owner-contract";
import { classifyPromptEvidence } from "@/lib/reconcile-evidence";
import { loadPromptEvidence } from "@/lib/reconcile-evidence-db";
import {
  executionCommands,
  nodeAttempts,
  runSessionIncarnations,
  runSessions,
  runs,
} from "@/lib/db/schema";

const log = pino({
  name: "budget-termination",
  level: process.env.LOG_LEVEL ?? "info",
});

type BudgetRun = Pick<
  Run,
  | "id"
  | "budgetState"
  | "executionAssignmentId"
  | "currentStepId"
  | "flowDriverToken"
>;

/** A released driver may finish yielding; a successor or new attempt never inherits its stop. */
export async function currentBudgetTermination(
  db: Db,
  run: BudgetRun,
): Promise<BudgetTermination | null> {
  const intent = run.budgetState?.termination;

  if (
    !intent ||
    intent.assignmentId !== run.executionAssignmentId ||
    intent.nodeId !== run.currentStepId ||
    (run.flowDriverToken !== null && run.flowDriverToken !== intent.driverToken)
  )
    return null;
  if (intent.runSessionId) {
    const [incarnation] = await db
      .select({ id: runSessionIncarnations.id })
      .from(runSessions)
      .innerJoin(
        runSessionIncarnations,
        and(
          eq(runSessionIncarnations.runSessionId, runSessions.id),
          eq(runSessionIncarnations.hostSessionId, runSessions.hostSessionId),
          eq(
            runSessionIncarnations.executionAssignmentId,
            runSessions.executionAssignmentId,
          ),
        ),
      )
      .where(
        and(
          eq(runSessions.id, intent.runSessionId),
          eq(runSessionIncarnations.id, intent.incarnationId!),
        ),
      )
      .limit(1);

    if (!incarnation) return null;
  }
  if (intent.nodeId) {
    const [attempt] = await db
      .select({ id: nodeAttempts.id })
      .from(nodeAttempts)
      .where(
        and(
          eq(nodeAttempts.runId, run.id),
          eq(nodeAttempts.nodeId, intent.nodeId!),
        ),
      )
      .orderBy(desc(nodeAttempts.attempt))
      .limit(1);

    if ((attempt?.id ?? null) !== intent.nodeAttemptId) return null;
  }

  return intent;
}

/** Serialize stop ownership with traversal commits, then release the lock before external I/O. */
export async function claimBudgetTermination(
  db: Db,
  input: Readonly<{
    runId: string;
    nodeId: string | null;
    scope: BudgetScope;
    meter: BudgetTermination["meter"];
    current: number;
    limit: number;
    assignmentId: string | null;
    sessionId: string | null;
    nodeDurationAttemptId?: string;
  }>,
): Promise<BudgetTermination | null> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, input.runId))
      .for("no key update");

    if (
      !run ||
      !["Running", "WaitingOnChildren"].includes(run.status) ||
      run.companyCancellationIntent !== null ||
      run.currentStepId !== input.nodeId ||
      run.executionAssignmentId !== input.assignmentId
    )
      return null;
    const current = await currentBudgetTermination(tx, run);

    if (current)
      return (input.nodeDurationAttemptId
        ? current.trigger === "node_duration" &&
          current.nodeAttemptId === input.nodeDurationAttemptId
        : current.trigger !== "node_duration") &&
        (input.sessionId === null || input.sessionId === current.sessionId)
        ? current
        : null;
    const [attempt] = input.nodeId
      ? await tx
          .select()
          .from(nodeAttempts)
          .where(
            and(
              eq(nodeAttempts.runId, run.id),
              eq(nodeAttempts.nodeId, input.nodeId),
            ),
          )
          .orderBy(desc(nodeAttempts.attempt))
          .limit(1)
      : [];

    // Preserve a result/failure committed before the stop request. Only an open
    // action is interrupted; a budget observer cannot relabel its old failure.
    if (attempt && attempt.status !== "Running") return null;
    if (input.nodeDurationAttemptId) {
      if (
        run.status !== "Running" ||
        attempt?.id !== input.nodeDurationAttemptId
      )
        return null;
      const evidence = classifyPromptEvidence(
        await loadPromptEvidence(tx, {
          runId: run.id,
          nodeAttemptId: attempt.id,
          variants: FLOW_NODE_ATTEMPT_VARIANTS,
        }),
      );

      if (evidence === "pending_application" || evidence === "applying")
        return null;
    } else if (input.sessionId || input.nodeId) {
      const [terminalPrompt] = await tx
        .select({ state: executionCommands.state })
        .from(executionCommands)
        .innerJoin(
          runSessions,
          and(
            eq(runSessions.runId, executionCommands.runId),
            eq(
              runSessions.executionAssignmentId,
              executionCommands.executionAssignmentId,
            ),
            eq(runSessions.hostSessionId, executionCommands.targetSessionId),
          ),
        )
        .where(
          and(
            eq(executionCommands.runId, run.id),
            eq(executionCommands.executionAssignmentId, input.assignmentId!),
            eq(executionCommands.kind, "session.prompt"),
            input.sessionId
              ? eq(executionCommands.targetSessionId, input.sessionId)
              : undefined,
            attempt
              ? sql`${executionCommands.ownerRef}->>'nodeAttemptId' = ${attempt.id}`
              : run.runKind === "flow"
                ? sql`false`
                : undefined,
          ),
        )
        .orderBy(desc(executionCommands.createdAt), desc(executionCommands.id))
        .limit(1);

      if (
        terminalPrompt &&
        ["succeeded", "failed"].includes(terminalPrompt.state)
      )
        return null;
    }
    const [incarnation] = input.sessionId
      ? await tx
          .select()
          .from(runSessionIncarnations)
          .where(
            and(
              eq(runSessionIncarnations.runId, run.id),
              eq(runSessionIncarnations.hostSessionId, input.sessionId),
            ),
          )
          .limit(1)
      : [];
    const intent: BudgetTermination = {
      version: 1,
      id: randomUUID(),
      scope: input.scope,
      meter: input.meter,
      ...(input.nodeDurationAttemptId ? { trigger: "node_duration" } : {}),
      current: input.current,
      limit: input.limit,
      requestedAt: new Date().toISOString(),
      assignmentId: run.executionAssignmentId,
      driverToken: run.flowDriverToken,
      nodeId: run.currentStepId,
      nodeAttemptId: attempt?.id ?? null,
      sessionId: input.sessionId,
      runSessionId: incarnation?.runSessionId ?? null,
      incarnationId: incarnation?.id ?? null,
    };

    await tx
      .update(runs)
      .set({ budgetState: { ...run.budgetState, termination: intent } })
      .where(eq(runs.id, run.id));
    log.info(
      {
        runId: run.id,
        scope: intent.scope,
        nodeAttemptId: intent.nodeAttemptId,
        assignmentId: intent.assignmentId,
        trigger: intent.trigger ?? "budget",
      },
      "[FIX] budget termination retained before teardown",
    );

    return intent;
  });
}
