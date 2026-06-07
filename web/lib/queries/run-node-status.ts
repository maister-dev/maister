import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { getRunTimeline, type TimelineEntry } from "@/lib/queries/run";

const { runs } = schema;

const log = pino({
  name: "run-node-status",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
type Db = NodePgDatabase<typeof schema>;

export interface GraphGateStatus {
  blocking: boolean;
  status: string;
}

export interface RuntimeGateSummary {
  total: number;
  blockingTotal: number;
  advisoryTotal: number;
  worstBlockingStatus: string | null;
  failedBlocking: number;
  staleBlocking: number;
}

export interface GraphNodeStatus {
  status: string;
  attempt: number;
  gates: GraphGateStatus[];
  rollup: string;
  gateSummary: RuntimeGateSummary;
}

export interface RunNodeStatuses {
  currentStepId: string | null;
  runStatus: string;
  nodes: Record<string, GraphNodeStatus>;
}

const GATE_STATUS_PRIORITY: Record<string, number> = {
  failed: 6,
  stale: 5,
  running: 4,
  pending: 3,
  overridden: 2,
  skipped: 1,
  passed: 0,
};

function blockingRollup(gates: GraphGateStatus[]): string {
  let worst: string | null = null;
  let worstPriority = -1;

  for (const gate of gates) {
    if (!gate.blocking) continue;

    const priority = GATE_STATUS_PRIORITY[gate.status] ?? -1;

    if (priority > worstPriority) {
      worstPriority = priority;
      worst = gate.status;
    }
  }

  return worst ?? "none";
}

function gateSummary(gates: GraphGateStatus[]): RuntimeGateSummary {
  const blocking = gates.filter((gate) => gate.blocking);
  const worstBlockingStatus = blockingRollup(gates);

  return {
    total: gates.length,
    blockingTotal: blocking.length,
    advisoryTotal: gates.length - blocking.length,
    worstBlockingStatus:
      worstBlockingStatus === "none" ? null : worstBlockingStatus,
    failedBlocking: blocking.filter((gate) => gate.status === "failed").length,
    staleBlocking: blocking.filter((gate) => gate.status === "stale").length,
  };
}

function highestAttemptByNode(
  entries: TimelineEntry[],
): Map<string, TimelineEntry> {
  const winners = new Map<string, TimelineEntry>();

  for (const entry of entries) {
    const current = winners.get(entry.nodeId);

    if (!current || entry.attempt > current.attempt) {
      winners.set(entry.nodeId, entry);
    }
  }

  return winners;
}

/**
 * Live node/gate status snapshot for a run: the highest-attempt status per node
 * with its blocking-gate rollup, plus the run's currentStepId and status echoed
 * from the run row. The SSE-triggered graph-status refetch reads this.
 */
export async function getRunNodeStatuses(
  runId: string,
): Promise<RunNodeStatuses> {
  const timeline = await getRunTimeline(runId);
  const winners = highestAttemptByNode(timeline.entries);

  const nodes: Record<string, GraphNodeStatus> = {};

  for (const [nodeId, entry] of winners) {
    const gates: GraphGateStatus[] = entry.gates.map((g) => ({
      blocking: g.mode === "blocking",
      status: g.status,
    }));

    nodes[nodeId] = {
      status: entry.status,
      attempt: entry.attempt,
      gates,
      rollup: blockingRollup(gates),
      gateSummary: gateSummary(gates),
    };
  }

  const client = getDb() as unknown as Db;
  const runRows = await client
    .select({ status: runs.status, currentStepId: runs.currentStepId })
    .from(runs)
    .where(eq(runs.id, runId));
  const run = runRows[0];

  log.debug(
    { runId, nodeCount: Object.keys(nodes).length },
    "[run-node-status]",
  );

  return {
    currentStepId: run?.currentStepId ?? null,
    runStatus: run?.status ?? "",
    nodes,
  };
}
