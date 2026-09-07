import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { AgentTurn, ExecutionHost } from "@/lib/db/schema";

import { and, eq, inArray, lt, sql } from "drizzle-orm";

import {
  agentTurns,
  executionAssignments,
  executionCommands,
  runs,
  runSessions,
  runSessionIncarnations,
} from "@/lib/db/schema";
import { capForPool, countLiveRuns, takeSchedulerLock } from "@/lib/scheduler";
import { claimAgentIdleResumeInTransaction } from "@/lib/runs/state-transitions";
import { MaisterError } from "@/lib/errors";

export type AgentTurnClaim =
  | Readonly<{ kind: "claimed"; turn: AgentTurn }>
  | Readonly<{ kind: "settled"; turn: AgentTurn }>
  | Readonly<{
      kind: "queued";
      turn: AgentTurn;
      reason: "capacity" | "prior_turn" | "run_state" | "session_projection";
    }>;

/** Serialize input binding with the same admission lock used by the scheduler. */
export async function claimAgentMessage(
  db: Db,
  turnId: string,
  placementHost: ExecutionHost,
): Promise<AgentTurnClaim> {
  const [source] = await db
    .select({ runId: agentTurns.runId })
    .from(agentTurns)
    .where(eq(agentTurns.id, turnId));

  if (!source)
    throw new MaisterError("PRECONDITION", "agent turn does not exist", {
      details: { turnId },
    });

  return db.transaction(async (tx): Promise<AgentTurnClaim> => {
    await takeSchedulerLock(tx);
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, source.runId))
      .for("update");
    const [turn] = await tx
      .select()
      .from(agentTurns)
      .where(eq(agentTurns.id, turnId))
      .for("update");

    if (!run || !turn)
      throw new MaisterError(
        "PRECONDITION",
        "agent turn was removed before admission",
        { details: { turnId } },
      );
    if (!["live_message", "persistent_message"].includes(turn.variant))
      throw new MaisterError(
        "PRECONDITION",
        "agent message claim requires a message turn",
        { details: { turnId, variant: turn.variant } },
      );
    if (turn.state === "applied" || turn.state === "superseded")
      return { kind: "settled", turn };
    if (run.runKind !== "agent" || !run.persistent)
      throw new MaisterError(
        "PRECONDITION",
        "agent message lost its persistent run authority",
        { details: { turnId } },
      );
    if (
      ["Done", "Failed", "Abandoned"].includes(run.status) ||
      (turn.executionAssignmentId !== null &&
        turn.executionAssignmentId !== run.executionAssignmentId)
    ) {
      const [superseded] = await tx
        .update(agentTurns)
        .set({
          state: "superseded",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agentTurns.id, turn.id))
        .returning();

      return { kind: "settled", turn: superseded };
    }
    if (run.status !== "Running" && run.status !== "NeedsInputIdle")
      return { kind: "queued", turn, reason: "run_state" };
    const defer = async (
      reason: Extract<AgentTurnClaim, { kind: "queued" }>["reason"],
    ): Promise<AgentTurnClaim> => {
      await tx
        .update(runs)
        .set({
          resumeRequestedAt: sql`coalesce(${runs.resumeRequestedAt}, ${turn.createdAt})`,
        })
        .where(eq(runs.id, run.id));

      return { kind: "queued", turn, reason };
    };
    const [earlier] = await tx
      .select({ id: agentTurns.id })
      .from(agentTurns)
      .where(
        and(
          eq(agentTurns.runId, run.id),
          lt(agentTurns.ordinal, turn.ordinal),
          inArray(agentTurns.state, ["queued", "claimed", "dispatched"]),
        ),
      )
      .limit(1);

    if (earlier) return defer("prior_turn");
    const [session] = await tx
      .select()
      .from(runSessions)
      .where(
        and(
          eq(runSessions.runId, run.id),
          eq(runSessions.sessionName, "default"),
        ),
      );

    if (!session)
      throw new MaisterError(
        "PRECONDITION",
        "agent message requires its logical session",
        { details: { runId: run.id, turnId } },
      );
    let assignmentId = run.executionAssignmentId;

    if (turn.state === "queued") {
      const [pendingPrompt] = await tx
        .select({ id: executionCommands.id })
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, run.id),
            eq(executionCommands.ownerKind, "agent_turn"),
            eq(executionCommands.kind, "session.prompt"),
            inArray(executionCommands.applicationState, [
              "pending",
              "applying",
              "poisoned",
            ]),
          ),
        )
        .limit(1);

      if (pendingPrompt) return defer("prior_turn");
    }
    if (run.status === "NeedsInputIdle") {
      if (turn.state !== "queued") return defer("run_state");
      if ((await countLiveRuns(tx, "agent")) >= capForPool("agent"))
        return defer("capacity");
      const claim = await claimAgentIdleResumeInTransaction(tx, run.id, {
        placement: { host: placementHost },
      });

      if (!claim.ok || !claim.assignment)
        throw new MaisterError(
          "CONFLICT",
          "agent message resume claim lost its run",
          { details: { turnId } },
        );
      assignmentId = claim.assignment.id;
    }
    const [assignment] =
      assignmentId === null
        ? []
        : await tx
            .select()
            .from(executionAssignments)
            .where(
              and(
                eq(executionAssignments.id, assignmentId),
                eq(executionAssignments.runId, run.id),
                eq(executionAssignments.state, "active"),
              ),
            );

    if (!assignment) return defer("run_state");
    if (turn.state === "claimed" || turn.state === "dispatched")
      return { kind: "claimed", turn };
    if (["launch", "legacy_backfill"].includes(assignment.placementReason)) {
      const [incarnation] = await tx
        .select({ id: runSessionIncarnations.id })
        .from(runSessionIncarnations)
        .where(
          and(
            eq(runSessionIncarnations.runSessionId, session.id),
            eq(runSessionIncarnations.executionAssignmentId, assignment.id),
            eq(runSessionIncarnations.state, "active"),
          ),
        )
        .limit(1);

      if (!incarnation) return defer("session_projection");
    }
    const [claimed] = await tx
      .update(agentTurns)
      .set({
        state: "claimed",
        executionAssignmentId: assignment.id,
        assignmentEpoch: assignment.epoch,
        runSessionId: session.id,
        updatedAt: new Date(),
      })
      .where(eq(agentTurns.id, turn.id))
      .returning();

    return { kind: "claimed", turn: claimed };
  });
}
