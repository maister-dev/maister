import "server-only";

import type { Db } from "./db";
import type { ExecutionCommand } from "@/lib/db/schema";

import { and, eq, gt, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { agentPermissionSourceSchema } from "./agent-permission-source";
import { PromptOwnerInvariantError } from "./prompt-owners";
import { staleSessionBinding } from "./session-binding";

import {
  agentTurns,
  executionCommands,
  executionEvents,
  runSessionIncarnations,
  runs,
} from "@/lib/db/schema";

export const agentPauseEnvelopeSchema = z.object({
  kind: z.enum(["hook_trip", "budget_breach"]),
  supervisorSessionId: z.string().min(1),
  agentPrompt: agentPermissionSourceSchema,
});

/** Capture in the pause transaction, before releasing its assignment. Absent
 * owned input denotes a pre-activation caller, never a reconstructed v2 source.
 */
export async function captureAgentPauseSource(
  tx: Db,
  input: {
    runId: string;
    assignmentId: string;
    sessionId: string;
  },
): Promise<{
  agentPrompt: z.infer<typeof agentPermissionSourceSchema>;
  supervisorSessionId: string;
} | null> {
  const [run] = await tx
    .select()
    .from(runs)
    .where(eq(runs.id, input.runId))
    .for("update");

  if (run?.runKind !== "agent") return null;
  if (run.executionAssignmentId !== input.assignmentId)
    throw staleSessionBinding(input.runId, input.assignmentId);
  const [turn] = await tx
    .select()
    .from(agentTurns)
    .where(
      and(
        eq(agentTurns.runId, run.id),
        eq(agentTurns.executionAssignmentId, input.assignmentId),
        eq(agentTurns.state, "dispatched"),
      ),
    )
    .for("update");

  if (!turn) return null;
  const [command] = await tx
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, turn.commandId ?? ""));
  const [incarnation] = await tx
    .select()
    .from(runSessionIncarnations)
    .where(eq(runSessionIncarnations.id, turn.incarnationId ?? ""));
  const ref = command?.ownerRef;

  if (
    !command ||
    command.kind !== "session.prompt" ||
    command.ownerKind !== "agent_turn" ||
    !ref ||
    !("turnId" in ref) ||
    !("promptOrdinal" in ref) ||
    command.runId !== run.id ||
    command.executionAssignmentId !== input.assignmentId ||
    command.assignmentEpoch !== turn.assignmentEpoch ||
    command.targetSessionId !== input.sessionId ||
    ref.turnId !== turn.id ||
    ref.runId !== run.id ||
    ref.variant !== turn.variant ||
    ref.promptOrdinal !== turn.ordinal ||
    ref.assignmentId !== input.assignmentId ||
    ref.assignmentEpoch !== turn.assignmentEpoch ||
    ref.incarnationId !== turn.incarnationId ||
    ref.runSessionId !== turn.runSessionId ||
    !incarnation ||
    incarnation.executionAssignmentId !== input.assignmentId ||
    incarnation.executionHostId !== command.executionHostId ||
    incarnation.assignmentEpoch !== turn.assignmentEpoch ||
    incarnation.runSessionId !== turn.runSessionId ||
    incarnation.hostSessionId !== input.sessionId
  )
    throw new PromptOwnerInvariantError("agent_pause_source_binding");

  return {
    supervisorSessionId: input.sessionId,
    agentPrompt: {
      version: 1,
      commandId: command.id,
      turnId: turn.id,
      promptOrdinal: turn.ordinal,
      assignmentId: input.assignmentId,
      incarnationId: incarnation.id,
    },
  };
}

/** A guardrail cancels the adapter before its web checkpoint. Its canonical
 * halt must lie inside this exact prompt's accepted-to-terminal host interval.
 */
export async function findAgentPromptHalt(
  db: Db,
  command: Readonly<ExecutionCommand>,
): Promise<{ id: string; rule: string } | null> {
  if (!command.terminalEventId || !command.targetSessionId) return null;
  const boundary = and(
    eq(executionEvents.source, "host"),
    eq(executionEvents.runId, command.runId),
    eq(executionEvents.executionHostId, command.executionHostId),
    eq(executionEvents.executionAssignmentId, command.executionAssignmentId),
    eq(executionEvents.assignmentEpoch, command.assignmentEpoch),
    eq(executionEvents.hostSessionId, command.targetSessionId),
    eq(executionEvents.ingestDisposition, "accepted"),
  );
  const [terminal] = await db
    .select()
    .from(executionEvents)
    .where(and(boundary, eq(executionEvents.id, command.terminalEventId)));
  const admissions = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        boundary,
        eq(executionEvents.eventType, "session.command"),
        sql`${executionEvents.payload}->>'commandId' = ${command.id}`,
        sql`${executionEvents.payload}->>'phase' = 'accepted'`,
        sql`${executionEvents.payload}->>'kind' = 'session.prompt'`,
      ),
    )
    .limit(2);
  const accepted = admissions[0];

  if (
    admissions.length !== 1 ||
    !accepted?.eventStreamId ||
    accepted.hostSequence === null ||
    !terminal ||
    terminal.eventStreamId !== accepted.eventStreamId ||
    terminal.hostSequence === null ||
    terminal.eventType !== "session.command" ||
    terminal.payload?.commandId !== command.id ||
    terminal.payload.kind !== "session.prompt" ||
    terminal.payload.phase !==
      (command.state === "succeeded" ? "completed" : "rejected")
  )
    return null;
  const events = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        boundary,
        eq(executionEvents.eventStreamId, accepted.eventStreamId),
        eq(executionEvents.eventType, "session.hook_trip"),
        gt(executionEvents.hostSequence, accepted.hostSequence),
        lt(executionEvents.hostSequence, terminal.hostSequence),
        sql`${executionEvents.payload}->>'disposition' = 'halt'`,
      ),
    )
    .limit(2);

  if (events.length === 0) return null;
  const halt = events[0];

  if (events.length !== 1 || typeof halt.payload?.rule !== "string")
    throw new PromptOwnerInvariantError("agent_pause_halt_identity");

  return { id: halt.id, rule: halt.payload.rule };
}
