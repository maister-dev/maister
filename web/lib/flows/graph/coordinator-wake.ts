import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { RunFlowOptions } from "./runner-core";

import { and, count, desc, eq, notInArray } from "drizzle-orm";
import pino from "pino";

import { executionAssignments, nodeAttempts, runs } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { SETTLED_RUN_STATUSES } from "@/lib/runs/run-status-sets";
import {
  markResumedFromWait,
  rollbackResumeFromWait,
} from "@/lib/runs/state-transitions";

const log = pino({
  name: "coordinator-wake",
  level: process.env.LOG_LEVEL ?? "info",
});

export type CoordinatorType = "orchestrator" | "consensus";
export type ResumeFlow = (
  runId: string,
  opts: RunFlowOptions,
) => Promise<void> | void;
export type CoordinatorWakeResult =
  | {
      kind: "woken";
      nodeType: CoordinatorType;
      nodeId: string;
      nodeAttemptId: string;
    }
  | { kind: "pending"; count: number }
  | { kind: "skipped"; reason: string };

export async function pendingCoordinatorChildCount(
  db: Db,
  parentRunId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(runs)
    .where(
      and(
        eq(runs.parentRunId, parentRunId),
        notInArray(runs.status, [...SETTLED_RUN_STATUSES]),
      ),
    );

  return Number(row?.n ?? 0);
}

export async function currentCoordinator(
  db: Db,
  parentRunId: string,
): Promise<{
  status: string;
  failedChildWakeAt: Date | null;
  nodeId: string;
  nodeAttemptId: string;
  nodeType: CoordinatorType;
} | null> {
  const [parent] = await db
    .select({
      runKind: runs.runKind,
      status: runs.status,
      failedChildWakeAt: runs.failedChildWakeAt,
      currentStepId: runs.currentStepId,
    })
    .from(runs)
    .where(eq(runs.id, parentRunId));

  if (parent?.runKind !== "flow" || !parent.currentStepId) return null;
  const [attempt] = await db
    .select({ id: nodeAttempts.id, nodeType: nodeAttempts.nodeType })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, parentRunId),
        eq(nodeAttempts.nodeId, parent.currentStepId),
      ),
    )
    .orderBy(desc(nodeAttempts.attempt))
    .limit(1);

  if (attempt?.nodeType !== "consensus" && attempt?.nodeType !== "orchestrator")
    return null;

  return {
    status: parent.status,
    failedChildWakeAt: parent.failedChildWakeAt,
    nodeId: parent.currentStepId,
    nodeAttemptId: attempt.id,
    nodeType: attempt.nodeType,
  };
}

/** The committed wait-resume assignment is a restart-safe wake intent. */
export async function readCoordinatorWakeIntent(
  db: Db,
  runId: string,
): Promise<{ nodeId: string; nodeType: CoordinatorType } | null> {
  const [run] = await db
    .select({
      status: runs.status,
      currentStepId: runs.currentStepId,
      assignmentId: runs.executionAssignmentId,
    })
    .from(runs)
    .where(eq(runs.id, runId));

  if (run?.status !== "Running" || !run.currentStepId || !run.assignmentId)
    return null;
  const [active] = await db
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.id, run.assignmentId));

  if (active?.state !== "active" || active.placementReason !== "wait_resume")
    return null;
  const [attempt] = await db
    .select({
      nodeType: nodeAttempts.nodeType,
      status: nodeAttempts.status,
      sourceAssignmentId: nodeAttempts.executionAssignmentId,
    })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, runId),
        eq(nodeAttempts.nodeId, run.currentStepId),
      ),
    )
    .orderBy(desc(nodeAttempts.attempt))
    .limit(1);

  if (
    attempt?.status !== "NeedsInput" ||
    (attempt.nodeType !== "consensus" && attempt.nodeType !== "orchestrator") ||
    !attempt.sourceAssignmentId
  )
    return null;
  const [source] = await db
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.id, attempt.sourceAssignmentId));

  if (
    source?.runId !== runId ||
    source.state !== "released" ||
    source.releasedReason !== "waiting_on_children" ||
    source.executionHostId !== active.executionHostId ||
    source.epoch >= active.epoch ||
    (attempt.nodeType === "consensus" &&
      (await pendingCoordinatorChildCount(db, runId)) > 0)
  )
    return null;

  return { nodeId: run.currentStepId, nodeType: attempt.nodeType };
}

async function rollbackOnRetryable(
  db: Db,
  parentRunId: string,
  error: unknown,
) {
  if (isMaisterError(error) && error.code === "EXECUTOR_UNAVAILABLE") {
    log.warn(
      { parentRunId, errorCode: error.code },
      "coordinator-resume-retryable",
    );
    await rollbackResumeFromWait(parentRunId, { db });

    return;
  }
  log.error(
    { parentRunId, code: isMaisterError(error) ? error.code : "UNKNOWN" },
    "coordinator-resume-failed",
  );
}

export type CoordinatorResumeOptions = Pick<
  RunFlowOptions,
  "runtimeRoot" | "executionHosts"
>;

async function dispatchResume(
  db: Db,
  parentRunId: string,
  nodeId: string,
  nodeType: CoordinatorType,
  injected?: ResumeFlow,
  resumeOptions: CoordinatorResumeOptions = {},
): Promise<void> {
  const options: RunFlowOptions = {
    ...resumeOptions,
    db,
    ...(nodeType === "orchestrator"
      ? { orchestratorResume: { targetStepId: nodeId } }
      : { consensusResume: { targetStepId: nodeId } }),
  };

  if (injected) {
    try {
      await injected(parentRunId, options);
    } catch (error) {
      await rollbackOnRetryable(db, parentRunId, error);
    }

    return;
  }

  queueMicrotask(() => {
    void (async () => {
      try {
        const { runFlow } = await import("@/lib/flows/runner");

        await runFlow(parentRunId, options);
      } catch (error) {
        await rollbackOnRetryable(db, parentRunId, error);
      }
    })();
  });
}

/** Event and post-park callers share the same predicate and single-winner CAS. */
export async function wakeParkedCoordinator(input: {
  db: Db;
  parentRunId: string;
  cause: "settled_child" | "post_park" | "continuation_worker";
  allowFailedOrchestratorChild?: boolean;
  expectedAttemptId?: string;
  resumeFlow?: ResumeFlow;
  resumeOptions?: CoordinatorResumeOptions;
}): Promise<CoordinatorWakeResult> {
  const coordinator = await currentCoordinator(input.db, input.parentRunId);

  if (!coordinator || coordinator.status !== "WaitingOnChildren")
    return { kind: "skipped", reason: "parent_not_parked_coordinator" };
  if (
    input.expectedAttemptId &&
    coordinator.nodeAttemptId !== input.expectedAttemptId
  )
    return { kind: "skipped", reason: "stale_attempt" };
  if (
    !(
      coordinator.nodeType === "orchestrator" &&
      (input.allowFailedOrchestratorChild ||
        coordinator.failedChildWakeAt !== null)
    )
  ) {
    const pending = await pendingCoordinatorChildCount(
      input.db,
      input.parentRunId,
    );

    if (pending > 0) return { kind: "pending", count: pending };
  }
  const claim = await markResumedFromWait(input.parentRunId, {
    db: input.db,
    expectedCoordinator: {
      nodeId: coordinator.nodeId,
      nodeAttemptId: coordinator.nodeAttemptId,
    },
  });

  if (!claim.ok) return { kind: "skipped", reason: claim.reason };

  log.info(
    {
      parentRunId: input.parentRunId,
      cause: input.cause,
      nodeId: coordinator.nodeId,
      nodeAttemptId: coordinator.nodeAttemptId,
      nodeType: coordinator.nodeType,
    },
    "coordinator-woken",
  );
  await dispatchResume(
    input.db,
    input.parentRunId,
    coordinator.nodeId,
    coordinator.nodeType,
    input.resumeFlow,
    input.resumeOptions,
  );

  return {
    kind: "woken",
    nodeType: coordinator.nodeType,
    nodeId: coordinator.nodeId,
    nodeAttemptId: coordinator.nodeAttemptId,
  };
}
