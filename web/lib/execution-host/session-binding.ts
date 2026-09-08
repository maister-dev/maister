import "server-only";

import type { Db } from "./db";
import type { ExecutionAssignment, RunSession } from "@/lib/db/schema";

import { and, eq, inArray, lt } from "drizzle-orm";

import {
  executionAssignments,
  runSessions,
  runSessionIncarnations,
  runs,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

export type SessionBindingDisposition = "applied" | "stale";

/** Serialize binding writes with assignment mint/release using their run-first
 * lock order. A historical receipt never grants current binding authority.
 */
export async function lockCurrentSessionAssignment(
  tx: Pick<Db, "select">,
  input: { runId: string; assignmentId: string },
): Promise<ExecutionAssignment | null> {
  const [run] = await tx
    .select({ assignmentId: runs.executionAssignmentId })
    .from(runs)
    .where(eq(runs.id, input.runId))
    .for("update")
    .limit(1);

  if (!run || run.assignmentId !== input.assignmentId) return null;
  const [assignment] = await tx
    .select()
    .from(executionAssignments)
    .where(
      and(
        eq(executionAssignments.id, input.assignmentId),
        eq(executionAssignments.runId, input.runId),
      ),
    )
    .for("update")
    .limit(1);

  return assignment?.state === "active" ? assignment : null;
}

export async function lockLogicalRunSession(
  tx: Pick<Db, "select">,
  input: { runId: string; sessionName: string },
): Promise<RunSession | null> {
  const [session] = await tx
    .select()
    .from(runSessions)
    .where(
      and(
        eq(runSessions.runId, input.runId),
        eq(runSessions.sessionName, input.sessionName),
      ),
    )
    .for("update")
    .limit(1);

  return session ?? null;
}

export function staleSessionBinding(
  runId: string,
  assignmentId: string,
): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "session binding belongs to a newer or released assignment",
    {
      details: {
        reason: "assignment_fenced",
        runId,
        assignmentId,
        local: true,
      },
    },
  );
}

/** Post-create domain writes must hold the same run/session fence until their
 * transaction commits; the ACK already persisted the ACP handle itself.
 */
export async function assertCurrentSessionBinding(
  tx: Pick<Db, "select">,
  input: {
    runId: string;
    sessionName: string;
    assignmentId: string;
    hostSessionId: string;
    acpSessionId: string;
  },
): Promise<void> {
  const assignment = await lockCurrentSessionAssignment(tx, input);

  if (!assignment) throw staleSessionBinding(input.runId, input.assignmentId);
  const session = await lockLogicalRunSession(tx, input);

  if (
    !session ||
    session.executionAssignmentId !== assignment.id ||
    session.hostSessionId !== input.hostSessionId ||
    session.acpSessionId !== input.acpSessionId
  )
    throw staleSessionBinding(input.runId, input.assignmentId);
}

/** A new current binding retires the previous assignment's projection slot.
 * This records loss of binding authority, not a fabricated host exit outcome.
 * The old incarnation, ACP handle and terminal evidence remain retained.
 */
export async function retireSupersededSessionIncarnations(
  tx: Db,
  input: { runSessionId: string; assignmentEpoch: number },
): Promise<void> {
  await tx
    .update(runSessionIncarnations)
    .set({
      state: "lost",
      endedAt: new Date(),
      terminalReason: { reason: "assignment_superseded" },
    })
    .where(
      and(
        eq(runSessionIncarnations.runSessionId, input.runSessionId),
        lt(runSessionIncarnations.assignmentEpoch, input.assignmentEpoch),
        inArray(runSessionIncarnations.state, [
          "created",
          "active",
          "checkpointed",
        ]),
      ),
    );
}
