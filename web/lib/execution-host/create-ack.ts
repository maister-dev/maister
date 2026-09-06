import type { Db } from "./db";
import type { SessionBindingDisposition } from "./session-binding";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import {
  lockCurrentSessionAssignment,
  lockLogicalRunSession,
  retireSupersededSessionIncarnations,
} from "./session-binding";

import {
  nodeAttempts,
  runSessionIncarnations,
  runSessions,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

/** Apply the create receipt in its ledger transaction. Stale outcomes remain
 * historical command evidence and cannot replace a successor binding/attempt.
 */
export async function applyCreateAck(
  tx: Db,
  input: {
    runId: string;
    sessionName: string;
    assignmentId: string;
    nodeAttemptId: string | null;
    result: { sessionId: string; acpSessionId: string | null };
  },
): Promise<SessionBindingDisposition> {
  const assignment = await lockCurrentSessionAssignment(tx, input);

  if (!assignment) return "stale";
  const session = await lockLogicalRunSession(tx, input);
  const [incarnation] = await tx
    .select()
    .from(runSessionIncarnations)
    .where(
      and(
        eq(runSessionIncarnations.executionHostId, assignment.executionHostId),
        eq(runSessionIncarnations.hostSessionId, input.result.sessionId),
      ),
    )
    .for("update")
    .limit(1);

  if (
    incarnation &&
    (incarnation.runId !== input.runId ||
      incarnation.executionAssignmentId !== assignment.id ||
      incarnation.assignmentEpoch !== assignment.epoch ||
      (session && incarnation.runSessionId !== session.id) ||
      !["created", "active"].includes(incarnation.state))
  )
    return "stale";
  if (input.nodeAttemptId) {
    const [attempt] = await tx
      .select({ runId: nodeAttempts.runId })
      .from(nodeAttempts)
      .where(eq(nodeAttempts.id, input.nodeAttemptId))
      .for("update")
      .limit(1);

    if (!attempt || attempt.runId !== input.runId)
      throw new MaisterError(
        "CONFLICT",
        "create acknowledgement references a different node attempt",
        {
          details: {
            reason: "command_invariant_conflict",
            nodeAttemptId: input.nodeAttemptId,
          },
        },
      );
  }
  if (session)
    await retireSupersededSessionIncarnations(tx, {
      runSessionId: session.id,
      assignmentEpoch: assignment.epoch,
    });
  const now = new Date();
  const binding = {
    hostSessionId: input.result.sessionId,
    acpSessionId: input.result.acpSessionId,
    executionAssignmentId: assignment.id,
    updatedAt: now,
  };

  if (session)
    await tx
      .update(runSessions)
      .set(binding)
      .where(eq(runSessions.id, session.id));
  else
    await tx.insert(runSessions).values({
      id: randomUUID(),
      runId: input.runId,
      sessionName: input.sessionName,
      ...binding,
      createdAt: now,
    });
  if (input.nodeAttemptId)
    await tx
      .update(nodeAttempts)
      .set({ executionAssignmentId: assignment.id })
      .where(
        and(
          eq(nodeAttempts.id, input.nodeAttemptId),
          eq(nodeAttempts.runId, input.runId),
        ),
      );

  return "applied";
}
