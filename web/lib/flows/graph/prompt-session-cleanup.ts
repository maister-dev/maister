import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { BoundClient } from "@/lib/execution-host/client";
import type { ExecutionCommand } from "@/lib/db/schema";

import { and, eq } from "drizzle-orm";

import { assertPermissionHandoffSource } from "@/lib/execution-host/permission-handoff-source";
import {
  executionAssignments,
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
    // ADR-175: a crash-recover handoff also lands an applied completion under a
    // NEWER generation than the command's, and it carries no `action_resume`
    // permission witness — deliberately, since a fifth `action_resume` kind
    // would need a migration and the design avoids one. Its authority is a
    // different, durable fact: the command's own assignment is no longer
    // `active`, so this client cannot address that session at all and there is
    // nothing here to close. The check revives no write authority — it only
    // decides whether a `deleteSession` goes out, exactly as the
    // permission-result branch below does when it returns without deleting.
    if (await sourceGenerationRetired(db, client, command)) return;
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

/** ADR-175: did `command` run under a generation that has since been retired,
 * with its completion applied onto the CURRENT generation's attempt? Then the
 * applied result crossed the boundary through a crash recover: its assignment
 * is released or superseded, so no client can address that session, and the
 * cleanup this module performs is neither possible nor needed. Every term is
 * durable state; none is an assertion made by the caller.
 *
 * Deliberately NOT keyed on the incarnation's state. A host-side crash leaves
 * the incarnation row non-terminal until the projected events settle — that is
 * exactly the window a recover runs in, so requiring a terminal state here
 * would make the witness unavailable precisely when it is needed.
 */
async function sourceGenerationRetired(
  db: Db,
  client: BoundClient,
  command: ExecutionCommand,
): Promise<boolean> {
  const ref = command.ownerRef;

  if (command.ownerKind !== "flow_node_attempt" || ref?.variant !== "node")
    return false;

  const [binding] = await db
    .select({ attempt: nodeAttempts, run: runs })
    .from(nodeAttempts)
    .innerJoin(runs, eq(runs.id, nodeAttempts.runId))
    .where(eq(nodeAttempts.id, ref.nodeAttemptId));

  if (
    !binding ||
    binding.run.id !== client.assignment.runId ||
    binding.run.executionAssignmentId !== client.assignment.id ||
    binding.attempt.executionAssignmentId !== client.assignment.id ||
    binding.attempt.actionCompletion?.commandId !== command.id
  )
    return false;

  const [source] = await db
    .select({ state: executionAssignments.state })
    .from(executionAssignments)
    .where(eq(executionAssignments.id, command.executionAssignmentId));

  return source !== undefined && source.state !== "active";
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
    attempt.actionCompletion?.commandId !== command.id
  )
    throw new PromptOwnerInvariantError("permission_result_cleanup_generation");
  await assertPermissionHandoffSource(db, {
    command,
    resume,
    assignment: client.assignment,
  });
}
