import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { BoundClient } from "@/lib/execution-host/client";
import type { ExecutionCommand } from "@/lib/db/schema";

import { and, eq } from "drizzle-orm";

import { assertPermissionResultSource } from "./permission-result-source";

import {
  executionCommands,
  nodeAttempts,
  runs,
  runSessionIncarnations,
} from "@/lib/db/schema";
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

  if (command && command.executionAssignmentId !== client.assignment.id) {
    await assertCheckpointedPermissionResult(db, client, command);

    return;
  }

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

/** A verified result may cross a checkpoint; its old session cannot be
 * addressed by the successor client. Validate durable handoff authority before
 * skipping cleanup, without reviving the historical owner's write authority.
 */
async function assertCheckpointedPermissionResult(
  db: Db,
  client: BoundClient,
  command: ExecutionCommand,
): Promise<void> {
  const ref = command.ownerRef;

  if (
    command.ownerKind !== "flow_node_attempt" ||
    (ref?.variant !== "node" && ref?.variant !== "permission_resume")
  )
    throw new PromptOwnerInvariantError("permission_result_cleanup_source");
  const [binding] = await db
    .select({ attempt: nodeAttempts, run: runs })
    .from(nodeAttempts)
    .innerJoin(runs, eq(runs.id, nodeAttempts.runId))
    .where(eq(nodeAttempts.id, ref.nodeAttemptId));
  const resume = binding?.attempt.actionResume;

  if (!binding || resume?.kind !== "permission_result")
    throw new PromptOwnerInvariantError("permission_result_cleanup_authority");
  const { run, attempt } = binding;

  if (
    run.id !== client.assignment.runId ||
    run.executionAssignmentId !== client.assignment.id ||
    attempt.executionAssignmentId !== client.assignment.id ||
    run.currentStepId !== attempt.nodeId ||
    attempt.status !== "Running" ||
    attempt.actionPromptOrdinal !== ref.promptOrdinal ||
    attempt.actionCompletion?.commandId !== command.id ||
    !attempt.actionCompletion.result.ok
  )
    throw new PromptOwnerInvariantError("permission_result_cleanup_generation");
  await assertPermissionResultSource(db, {
    command,
    resume,
    assignment: client.assignment,
  });
}
