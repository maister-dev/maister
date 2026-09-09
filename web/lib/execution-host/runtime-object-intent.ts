import "server-only";

import type { Db } from "./db";
import type { RuntimeObjectBinding } from "./runtime-object-evidence";

import { and, eq } from "drizzle-orm";

import { executionAssignments, executionCommands } from "@/lib/db/schema";

/** Historical output belongs only to its exact committed session command. */
export async function hasNativeOutputCommand(
  tx: Db,
  input: Pick<
    RuntimeObjectBinding,
    "runId" | "executionHostId" | "executionAssignmentId" | "assignmentEpoch"
  > & { commandId: string; hostSessionId: string },
): Promise<boolean> {
  const [command] = await tx
    .select({
      kind: executionCommands.kind,
      targetSessionId: executionCommands.targetSessionId,
    })
    .from(executionCommands)
    .innerJoin(
      executionAssignments,
      eq(executionAssignments.id, executionCommands.executionAssignmentId),
    )
    .where(
      and(
        eq(executionCommands.id, input.commandId),
        eq(executionCommands.runId, input.runId),
        eq(executionCommands.executionHostId, input.executionHostId),
        eq(
          executionCommands.executionAssignmentId,
          input.executionAssignmentId,
        ),
        eq(executionCommands.assignmentEpoch, input.assignmentEpoch),
        eq(executionAssignments.runId, input.runId),
        eq(executionAssignments.executionHostId, input.executionHostId),
        eq(executionAssignments.epoch, input.assignmentEpoch),
      ),
    )
    .limit(1);

  return Boolean(
    command &&
      command.kind.startsWith("session.") &&
      (command.kind === "session.create" ||
        command.targetSessionId === input.hostSessionId),
  );
}
