import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { AgentTurn } from "@/lib/db/schema";
import type { BoundClient } from "@/lib/execution-host/client";
import type { AgentFinalizationApplication } from "./finalization";

import { eq } from "drizzle-orm";

import { prepareAgentRunFinalization } from "./finalization";

import { agentTurns } from "@/lib/db/schema";
import {
  latestOwnedCreate,
  readCreateIntent,
} from "@/lib/execution-host/create-intent";
import { lockCurrentSessionAssignment } from "@/lib/execution-host/session-binding";
import { UNKNOWN_OUTCOME_DETAIL } from "@/lib/execution-host/contracts";

/** A refused create produced no prompt; close only its original admitted input. */
export async function settleAgentCreateFailure(
  db: Db,
  client: BoundClient,
  source: AgentTurn,
): Promise<boolean> {
  const prepared = await prepareAgentRunFinalization(source.runId, "Failed", {
    db,
    reason: "agent_session_create_failed",
  });
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
      const result = await prepared.apply(tx);

      if (!result.finalized) return result;
      await tx
        .update(agentTurns)
        .set({
          state: "superseded",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agentTurns.id, turn.id));

      return result;
    },
  );

  await prepared.afterCommit(application);

  return application.finalized;
}
