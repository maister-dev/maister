import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { BoundClient } from "@/lib/execution-host/client";

import { and, eq } from "drizzle-orm";

import { executionCommands, runSessionIncarnations } from "@/lib/db/schema";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";

/** Resume the post-application cleanup lost with a caller's stack. The exact
 * source incarnation is authoritative; never delete today's logical session
 * by looking up only the run/session name after a successor has replaced it.
 */
export async function closeAppliedFlowPromptSession(
  db: Db,
  client: BoundClient,
  commandId: string,
): Promise<void> {
  const [command] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, commandId));

  if (
    !command ||
    command.runId !== client.assignment.runId ||
    command.executionAssignmentId !== client.assignment.id ||
    command.ownerKind !== "flow_node_attempt" ||
    command.applicationState !== "applied" ||
    !command.completionAppliedAt ||
    !command.targetSessionId ||
    !command.ownerRef
  )
    throw new PromptOwnerInvariantError("flow_prompt_cleanup_generation");
  const [incarnation] = await db
    .select()
    .from(runSessionIncarnations)
    .where(
      and(
        eq(runSessionIncarnations.id, command.ownerRef.incarnationId),
        eq(runSessionIncarnations.hostSessionId, command.targetSessionId),
        eq(runSessionIncarnations.executionAssignmentId, client.assignment.id),
      ),
    );

  if (!incarnation)
    throw new PromptOwnerInvariantError("flow_prompt_cleanup_incarnation");
  if (["exited", "crashed", "lost", "deleted"].includes(incarnation.state))
    return;
  await client.deleteSession(command.targetSessionId);
}
