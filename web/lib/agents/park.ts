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
  const [parked] = await tx
    .update(runs)
    .set({
      status: "NeedsInputIdle",
      checkpointAt: new Date(),
      keepaliveUntil: null,
      resumeRequestedAt: sql`(SELECT min(${agentTurns.createdAt}) FROM ${agentTurns}
        WHERE ${agentTurns.runId} = ${runId} AND ${agentTurns.state} = 'queued')`,
    })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.runKind, "agent"),
        eq(runs.persistent, true),
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
