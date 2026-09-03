import type { Db } from "./db";

import { eq } from "drizzle-orm";

import { persistRunSessionHostBinding } from "@/lib/runs/active-run-session";
import { nodeAttempts } from "@/lib/db/schema";

// ADR-166 E-EH-07: the result-derived domain writes of a `session.create` ack,
// applied in the SAME transaction as the ledger transition by the client's ack
// and by the recovery fold alike (one composition, never two). The flow
// attempt that owns the session is stamped with the driver generation here,
// not at append time: an attempt whose host binding fails must still exist in
// the ledger as Failed.
export async function applyCreateAck(
  tx: Db,
  input: {
    runId: string;
    sessionName: string;
    assignmentId: string;
    nodeAttemptId: string | null;
    result: { sessionId: string; acpSessionId: string | null };
  },
): Promise<void> {
  await persistRunSessionHostBinding(tx, {
    runId: input.runId,
    sessionName: input.sessionName,
    hostSessionId: input.result.sessionId,
    acpSessionId: input.result.acpSessionId,
    executionAssignmentId: input.assignmentId,
  });

  if (input.nodeAttemptId) {
    await tx
      .update(nodeAttempts)
      .set({ executionAssignmentId: input.assignmentId })
      .where(eq(nodeAttempts.id, input.nodeAttemptId));
  }
}
