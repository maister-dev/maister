import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { AgentTurn } from "@/lib/db/schema";
import type { BoundClient } from "@/lib/execution-host/client";
import type { AgentFinalizationApplication } from "./finalization";
import type { AgentParkApplication } from "./park";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { prepareAgentRunFinalization } from "./finalization";
import { afterPersistentAgentPark, applyAgentPark } from "./park";
import { insertHostParkSuccessor } from "./host-park-settlement";

import { agentTurns, runs } from "@/lib/db/schema";
import {
  latestOwnedCreate,
  readCreateIntent,
} from "@/lib/execution-host/create-intent";
import { lockCurrentSessionAssignment } from "@/lib/execution-host/session-binding";
import { UNKNOWN_OUTCOME_DETAIL } from "@/lib/execution-host/contracts";
import { isHostPressureFailure } from "@/lib/execution-host/host-pressure";

const log = pino({
  name: "agent-create-failure",
  level: process.env.LOG_LEVEL ?? "info",
});

/** A refused create produced no prompt; close only its original admitted input.
 * A create the host refused for outbox pressure parks instead (below). */
export async function settleAgentCreateFailure(
  db: Db,
  client: BoundClient,
  source: AgentTurn,
): Promise<boolean> {
  const prepared = await prepareAgentRunFinalization(source.runId, "Failed", {
    db,
    reason: "agent_session_create_failed",
  });
  let hostPressured = false;
  const application = await db.transaction(
    async (tx): Promise<AgentFinalizationApplication> => {
      const assignment = await lockCurrentSessionAssignment(tx, {
        runId: source.runId,
        assignmentId: client.assignment.id,
      });

      if (!assignment) return { finalized: false };
      const [turn] = await tx
        .select()
        .from(agentTurns)
        .where(eq(agentTurns.id, source.id))
        .for("update");

      if (
        !turn ||
        turn.state !== "claimed" ||
        turn.commandId !== null ||
        turn.executionAssignmentId !== assignment.id ||
        turn.assignmentEpoch !== assignment.epoch
      )
        return { finalized: false };
      const create = await latestOwnedCreate(tx, {
        runId: turn.runId,
        assignmentId: assignment.id,
        owner: {
          variant: "agent",
          turnId: turn.id,
          promptOrdinal: turn.ordinal,
        },
      });

      if (!create || create.state !== "failed") return { finalized: false };
      const details = create.lastError?.details;

      if (
        details &&
        typeof details === "object" &&
        "transport" in details &&
        details.transport === UNKNOWN_OUTCOME_DETAIL
      )
        return { finalized: false };
      readCreateIntent(create, client.host.hostKey);
      if (isHostPressureFailure(create.lastError)) {
        hostPressured = true;

        return { finalized: false };
      }
      const result = await prepared.apply(tx);

      if (!result.finalized) return result;
      // A message turn the finalization already superseded keeps its stamp:
      // `completed_at` is immutable once set (agent_turns_binding_immutable).
      await tx
        .update(agentTurns)
        .set({
          state: "superseded",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(eq(agentTurns.id, turn.id), eq(agentTurns.state, "claimed")),
        );

      return result;
    },
  );

  if (hostPressured)
    return parkClaimedAgentTurnForHostPressure(db, client, source);
  await prepared.afterCommit(application);

  return application.finalized;
}

/** ADR-183 D-M3: the host refused this turn's dispatch (its create, or a
 * command before it) because its outbox is behind. That is not a failure for
 * a MESSAGE: the claimed turn — whose binding is immutable — is superseded and
 * re-queued as its successor, and the run parks until the host catches up. A
 * generation turn cannot be repeated from a refused dispatch (the resume
 * invariant needs an applied predecessor with the same input), so it keeps its
 * existing settlement — reachable only in the W9 window, since the refusal
 * itself writes the pressure record and later admissions queue.
 */
export async function parkClaimedAgentTurnForHostPressure(
  db: Db,
  client: BoundClient,
  source: AgentTurn,
): Promise<boolean> {
  let park: AgentParkApplication = { parked: false };

  await db.transaction(async (tx) => {
    const assignment = await lockCurrentSessionAssignment(tx, {
      runId: source.runId,
      assignmentId: client.assignment.id,
    });

    if (!assignment) return;
    await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, source.runId))
      .for("update");
    const [turn] = await tx
      .select()
      .from(agentTurns)
      .where(eq(agentTurns.id, source.id))
      .for("update");

    if (
      !turn ||
      (turn.variant !== "live_message" &&
        turn.variant !== "persistent_message") ||
      turn.state !== "claimed" ||
      turn.commandId !== null ||
      turn.executionAssignmentId !== assignment.id ||
      turn.assignmentEpoch !== assignment.epoch
    )
      return;
    const now = new Date();

    await tx
      .update(agentTurns)
      .set({ state: "superseded", completedAt: now, updatedAt: now })
      .where(and(eq(agentTurns.id, turn.id), eq(agentTurns.state, "claimed")));
    const successor = await insertHostParkSuccessor(tx, turn);

    park = await applyAgentPark(tx, turn.runId, { cause: "host_pressure" });
    log.warn(
      {
        runId: turn.runId,
        turnId: turn.id,
        successorTurnId: successor.id,
        parked: park.parked,
      },
      "agent-dispatch-host-pressure-requeued",
    );
  });

  if (!park.parked) return false;
  await afterPersistentAgentPark(db, source.runId, park);

  return true;
}
