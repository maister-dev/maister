import "server-only";

import type { Interval, RunTiming } from "@/lib/runs/run-timing";

import { and, inArray, notInArray } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { computeRunTiming } from "@/lib/runs/run-timing";

// FIXME(any): dual drizzle-orm peer-dep variants (matches services/tasks.ts).
const { agentTurns, hitlRequests, nodeAttempts, runs } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): narrow after the repository converges on one drizzle peer.
type Db = any;

const log = pino({
  name: "queries-run-timing",
  level: process.env.LOG_LEVEL ?? "info",
});

// Human/form nodes are waits for a person, never execution.
const NON_EXECUTION_NODE_TYPES = ["human", "form"];
// A superseded turn never ran; queued/claimed have not started.
const EXECUTED_TURN_STATES = ["dispatched", "applied"];

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
  const [attempts, turns, hitl] = await Promise.all([
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
        runId: agentTurns.runId,
        createdAt: agentTurns.createdAt,
        completedAt: agentTurns.completedAt,
      })
      .from(agentTurns)
      .where(
        and(
          inArray(agentTurns.runId, allIds),
          inArray(agentTurns.state, EXECUTED_TURN_STATES),
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
  ]);
  const attemptsByRun = groupBy(
    attempts as Array<{ runId: string; startedAt: Date; endedAt: Date | null }>,
    (a) => a.runId,
  );
  const turnsByRun = groupBy(
    turns as Array<{
      runId: string;
      createdAt: Date;
      completedAt: Date | null;
    }>,
    (t) => t.runId,
  );
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
  const ownExecution = (run: RunRow): Interval[] =>
    run.runKind === "flow"
      ? (attemptsByRun.get(run.id) ?? []).map((a) =>
          span(a.startedAt, a.endedAt),
        )
      : (turnsByRun.get(run.id) ?? []).map((t) =>
          span(t.createdAt, t.completedAt),
        );
  const timings = new Map<string, RunTiming>();

  for (const run of parents) {
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
      }),
    );
  }

  return timings;
}
