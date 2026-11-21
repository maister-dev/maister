import "server-only";

import type { Interval, RunTiming } from "@/lib/runs/run-timing";

import { and, eq, inArray, isNotNull, notInArray, or } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import {
  promptReceiptAcceptance,
  settledPromptReceiptReceivedAt,
} from "@/lib/execution-host/prompt-receipt-acceptance";
import { computeRunTiming } from "@/lib/runs/run-timing";

// FIXME(any): dual drizzle-orm peer-dep variants (matches services/tasks.ts).
const {
  executionAssignments,
  executionCommands,
  hitlRequests,
  nodeAttempts,
  runs,
  runWaits,
} = schemaModule as unknown as Record<string, any>;

// FIXME(any): narrow after the repository converges on one drizzle peer.
type Db = any;

const log = pino({
  name: "queries-run-timing",
  level: process.env.LOG_LEVEL ?? "info",
});

// Human/form and durable condition nodes represent suspension intervals.
const NON_EXECUTION_NODE_TYPES = ["human", "form", "wait"];
// These owners record standalone agent and scratch prompts in the same ledger.
const TIMED_PROMPT_OWNERS = ["agent_turn", "scratch_message"];

type RunRow = {
  id: string;
  runKind: string;
  parentRunId: string | null;
  startedAt: Date;
  endedAt: Date | null;
  checkpointAt: Date | null;
  resumeStartedAt: Date | null;
};

function span(start: Date, end: Date | null): Interval {
  return { start: start.getTime(), end: end ? end.getTime() : null };
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const row of rows)
    groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);

  return groups;
}

/**
 * ADR-208: Duration + Execution for many Runs in one batch — one query per
 * evidence table, children (one level) folded into their parent's window.
 */
export async function loadRunTimings(
  db: Db,
  runIds: string[],
  now: Date = new Date(),
): Promise<Map<string, RunTiming>> {
  if (runIds.length === 0) return new Map();

  const runColumns = {
    id: runs.id,
    runKind: runs.runKind,
    parentRunId: runs.parentRunId,
    startedAt: runs.startedAt,
    endedAt: runs.endedAt,
    checkpointAt: runs.checkpointAt,
    resumeStartedAt: runs.resumeStartedAt,
  };
  const [parents, children]: [RunRow[], RunRow[]] = await Promise.all([
    db.select(runColumns).from(runs).where(inArray(runs.id, runIds)),
    db.select(runColumns).from(runs).where(inArray(runs.parentRunId, runIds)),
  ]);
  const all = [...parents, ...children];
  const allIds = all.map((r) => r.id);
  const [attempts, prompts, hitl, conditionWaits] = await Promise.all([
    db
      .select({
        runId: nodeAttempts.runId,
        startedAt: nodeAttempts.startedAt,
        endedAt: nodeAttempts.endedAt,
      })
      .from(nodeAttempts)
      .where(
        and(
          inArray(nodeAttempts.runId, allIds),
          notInArray(nodeAttempts.nodeType, NON_EXECUTION_NODE_TYPES),
        ),
      ),
    db
      .select({
        runId: executionCommands.runId,
        acceptedAt: executionCommands.acceptedAt,
        completedAt: executionCommands.completedAt,
        receiptReceivedAt: settledPromptReceiptReceivedAt,
      })
      .from(executionCommands)
      .where(
        and(
          inArray(executionCommands.runId, allIds),
          eq(executionCommands.kind, "session.prompt"),
          inArray(executionCommands.ownerKind, TIMED_PROMPT_OWNERS),
          or(
            isNotNull(executionCommands.acceptedAt),
            isNotNull(settledPromptReceiptReceivedAt),
          ),
        ),
      ),
    db
      .select({
        runId: hitlRequests.runId,
        createdAt: hitlRequests.createdAt,
        respondedAt: hitlRequests.respondedAt,
        supersededAt: hitlRequests.supersededAt,
      })
      .from(hitlRequests)
      .where(inArray(hitlRequests.runId, runIds)),
    db
      .select({
        runId: runWaits.runId,
        openedAt: runWaits.openedAt,
        resolvedAt: runWaits.resolvedAt,
        closedAt: runWaits.closedAt,
        queuedAt: runWaits.queuedAt,
        admittedAt: executionAssignments.createdAt,
      })
      .from(runWaits)
      .leftJoin(
        executionAssignments,
        eq(runWaits.resumeAssignmentId, executionAssignments.id),
      )
      .where(
        and(inArray(runWaits.runId, runIds), isNotNull(runWaits.openedAt)),
      ),
  ]);
  const attemptsByRun = groupBy(
    attempts as Array<{ runId: string; startedAt: Date; endedAt: Date | null }>,
    (a) => a.runId,
  );
  const promptRows = prompts as Array<{
    runId: string;
    acceptedAt: Date | null;
    completedAt: Date | null;
    receiptReceivedAt: string | null;
  }>;
  const acceptedPrompts = promptRows.flatMap((prompt) => {
    const acceptedAt =
      prompt.acceptedAt ?? promptReceiptAcceptance(prompt.receiptReceivedAt);

    return acceptedAt
      ? [
          {
            runId: prompt.runId,
            interval: span(acceptedAt, prompt.completedAt),
          },
        ]
      : [];
  });
  const promptsByRun = groupBy(acceptedPrompts, (prompt) => prompt.runId);
  const hitlByRun = groupBy(
    hitl as Array<{
      runId: string;
      createdAt: Date;
      respondedAt: Date | null;
      supersededAt: Date | null;
    }>,
    (h) => h.runId,
  );
  const childrenByParent = groupBy(children, (c) => c.parentRunId as string);
  const conditionWaitsByRun = groupBy(
    conditionWaits as Array<{
      runId: string;
      openedAt: Date;
      resolvedAt: Date | null;
      closedAt: Date | null;
      queuedAt: Date | null;
      admittedAt: Date | null;
    }>,
    (wait) => wait.runId,
  );
  const ownExecution = (run: RunRow): Interval[] =>
    run.runKind === "flow"
      ? (attemptsByRun.get(run.id) ?? []).map((a) =>
          span(a.startedAt, a.endedAt),
        )
      : (promptsByRun.get(run.id) ?? []).map((prompt) => prompt.interval);
  const timings = new Map<string, RunTiming>();

  log.debug(
    { runCount: runIds.length, acceptedPromptCount: acceptedPrompts.length },
    "[FIX:run-timing] loaded durable prompt acceptance evidence",
  );

  for (const run of parents) {
    const waits = conditionWaitsByRun.get(run.id) ?? [];

    if (run.endedAt && run.endedAt < run.startedAt) {
      log.warn({ runId: run.id }, "[runTiming] ended_at precedes started_at");
    }
    timings.set(
      run.id,
      computeRunTiming({
        startedAt: run.startedAt.getTime(),
        endedAt: run.endedAt ? run.endedAt.getTime() : null,
        now: now.getTime(),
        execution: ownExecution(run),
        childExecution: (childrenByParent.get(run.id) ?? []).flatMap(
          ownExecution,
        ),
        hitl: (hitlByRun.get(run.id) ?? []).map((h) =>
          span(h.createdAt, h.respondedAt ?? h.supersededAt),
        ),
        checkpoints: run.checkpointAt
          ? [span(run.checkpointAt, run.resumeStartedAt)]
          : [],
        conditionWaits: waits.map((wait) =>
          span(wait.openedAt, wait.resolvedAt ?? wait.closedAt),
        ),
        readmissions: waits.flatMap((wait) =>
          wait.queuedAt ? [span(wait.queuedAt, wait.admittedAt)] : [],
        ),
      }),
    );
  }

  return timings;
}
