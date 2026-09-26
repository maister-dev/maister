import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionAssignment } from "@/lib/db/schema";

import { and, desc, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { admitAgentGenerationTurn } from "./generation-turn";
import { OWNED_TURN_VARIANTS } from "./turn-variants";

import { agentTurns, executionAssignments } from "@/lib/db/schema";

const log = pino({
  name: "agent-resume",
  level: process.env.LOG_LEVEL ?? "info",
});

/** An ordinary idle wake repeats the retained completed input. Queued messages
 * own their next turn; an interrupted source needs a separate checkpoint proof.
 * Called inside the scheduler/run-locked assignment claim.
 */
export async function admitCompletedAgentResume(
  tx: Db,
  assignment: ExecutionAssignment,
): Promise<void> {
  const [queued] = await tx
    .select({ id: agentTurns.id })
    .from(agentTurns)
    .where(
      and(
        eq(agentTurns.runId, assignment.runId),
        eq(agentTurns.state, "queued"),
      ),
    )
    .limit(1);

  if (queued) return;
  // ADR-182: a steer is never a turn to repeat — it rode its parent's.
  const [source] = await tx
    .select()
    .from(agentTurns)
    .where(
      and(
        eq(agentTurns.runId, assignment.runId),
        inArray(agentTurns.variant, [...OWNED_TURN_VARIANTS]),
      ),
    )
    .orderBy(desc(agentTurns.ordinal))
    .limit(1);

  if (source?.state !== "applied" || !source.executionAssignmentId) return;
  const [prior] = await tx
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.id, source.executionAssignmentId));

  if (
    prior?.state !== "released" ||
    prior.releasedReason !== "parked" ||
    prior.epoch >= assignment.epoch ||
    prior.executionHostId !== assignment.executionHostId
  )
    return;
  const turn = await admitAgentGenerationTurn(tx, {
    runId: assignment.runId,
    assignmentId: assignment.id,
    variant: "resume",
    prompt: source.prompt,
  });

  log.info(
    {
      runId: assignment.runId,
      assignmentId: assignment.id,
      sourceTurnId: source.id,
      turnId: turn.id,
    },
    "agent-completed-turn-resume-admitted",
  );
}
