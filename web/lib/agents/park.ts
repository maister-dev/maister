import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { agentTurns, runs } from "@/lib/db/schema";
import { releaseAssignmentForRun } from "@/lib/execution-host/assignments";
import { releaseSlotOnIdle } from "@/lib/scheduler";

const log = pino({
  name: "agent-park",
  level: process.env.LOG_LEVEL ?? "info",
});

export type AgentParkApplication =
  | Readonly<{ parked: false }>
  | Readonly<{
      parked: true;
      checkpointAt: Date;
      assignmentId: string | null;
    }>;

/** DB-only park; owned callers lock their exact turn before this transition. */
export async function applyPersistentAgentPark(
  tx: Db,
  runId: string,
): Promise<AgentParkApplication> {
  return applyAgentPark(tx, runId);
}

/** ADR-183 D-M3: the host-pressure park is the persistent park for ANY agent
 * run — a one-shot run parked by its host is not done, it is interrupted — and
 * it always asks for a resume: its interrupted turn may have left no queued
 * successor to date the request by. */
export async function applyAgentPark(
  tx: Db,
  runId: string,
  opts: { cause?: "host_pressure" } = {},
): Promise<AgentParkApplication> {
  const queuedSince = sql`(SELECT min(${agentTurns.createdAt}) FROM ${agentTurns}
        WHERE ${agentTurns.runId} = ${runId} AND ${agentTurns.state} = 'queued')`;
  const hostPark = opts.cause === "host_pressure";
  const [parked] = await tx
    .update(runs)
    .set({
      status: "NeedsInputIdle",
      checkpointAt: new Date(),
      keepaliveUntil: null,
      resumeRequestedAt: hostPark
        ? sql`coalesce(${queuedSince}, clock_timestamp())`
        : queuedSince,
    })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.runKind, "agent"),
        ...(hostPark ? [] : [eq(runs.persistent, true)]),
        eq(runs.status, "Running"),
      ),
    )
    .returning({
      checkpointAt: runs.checkpointAt,
      assignmentId: runs.executionAssignmentId,
    });

  if (!parked?.checkpointAt) return { parked: false };
  await releaseAssignmentForRun(tx, runId, "parked");

  return {
    parked: true,
    checkpointAt: parked.checkpointAt,
    assignmentId: parked.assignmentId,
  };
}

/** Scheduler hint; the agent tick independently retries durable queued work. */
export async function afterPersistentAgentPark(
  db: Db,
  runId: string,
  application: AgentParkApplication,
): Promise<void> {
  if (!application.parked) return;
  const [current] = await db.select().from(runs).where(eq(runs.id, runId));

  if (
    current?.status !== "NeedsInputIdle" ||
    current.executionAssignmentId !== application.assignmentId ||
    current.checkpointAt?.getTime() !== application.checkpointAt.getTime()
  )
    return;
  await releaseSlotOnIdle({ runId, db });
  log.info(
    { runId, assignmentId: application.assignmentId },
    "persistent-agent-parked",
  );
}
