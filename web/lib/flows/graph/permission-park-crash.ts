import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionCommand } from "@/lib/db/schema";

import { and, eq, isNull, lte, or } from "drizzle-orm";
import pino from "pino";

import { markGateStale } from "./gate-store";

import {
  executionEvents,
  gateResults,
  nodeAttempts,
  runSessionIncarnations,
  runs,
} from "@/lib/db/schema";
import { isTurnLostError } from "@/lib/reconcile-evidence";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owner-errors";
import {
  closeTurnLostAttempt,
  TurnLostCasLost,
} from "@/lib/runs/turn-lost-boundary";

const log = pino({
  name: "flow-permission-park-crash",
  level: process.env.LOG_LEVEL ?? "info",
});

type ParkOwner =
  | Readonly<{
      variant: "node" | "permission_resume";
      nodeAttemptId: string;
      promptOrdinal: number;
    }>
  | Readonly<{
      variant: "gate_ai" | "gate_skill";
      nodeAttemptId: string;
      gateId: string;
      evaluationId: string;
      promptOrdinal: number;
    }>;

export type ChildCrashProof = Readonly<{
  eventId: string;
  streamId: string;
  crashSequence: string;
  terminalEventId: string;
  terminalSequence: string;
}>;

/** A failed prompt is not itself a crash. The accepted host event must name
 * the exact owned session and precede that command's terminal in one stream. */
export async function childCrashPrecededTerminal(
  tx: Db,
  command: ExecutionCommand,
): Promise<ChildCrashProof | null> {
  const incarnationId = command.ownerRef?.incarnationId;

  if (!command.terminalEventId || !command.targetSessionId || !incarnationId)
    return null;
  const [terminal] = await tx
    .select({
      streamId: executionEvents.eventStreamId,
      hostSequence: executionEvents.hostSequence,
    })
    .from(executionEvents)
    .where(eq(executionEvents.id, command.terminalEventId));

  if (!terminal?.streamId || terminal.hostSequence === null) return null;
  const [crash] = await tx
    .select({
      id: executionEvents.id,
      sequence: executionEvents.hostSequence,
    })
    .from(executionEvents)
    .innerJoin(
      runSessionIncarnations,
      and(
        eq(runSessionIncarnations.id, incarnationId),
        eq(runSessionIncarnations.runId, executionEvents.runId),
        eq(
          runSessionIncarnations.executionHostId,
          executionEvents.executionHostId,
        ),
        eq(runSessionIncarnations.hostSessionId, executionEvents.hostSessionId),
        eq(
          runSessionIncarnations.executionAssignmentId,
          executionEvents.executionAssignmentId,
        ),
        eq(
          runSessionIncarnations.assignmentEpoch,
          executionEvents.assignmentEpoch,
        ),
      ),
    )
    .where(
      and(
        eq(executionEvents.source, "host"),
        eq(executionEvents.eventStreamId, terminal.streamId),
        lte(executionEvents.hostSequence, terminal.hostSequence),
        eq(executionEvents.runId, command.runId),
        eq(
          executionEvents.executionAssignmentId,
          command.executionAssignmentId,
        ),
        eq(executionEvents.assignmentEpoch, command.assignmentEpoch),
        eq(executionEvents.hostSessionId, command.targetSessionId),
        // The immutable host/session uniqueness proves the owner even while
        // lifecycle projection is pending. A contradictory projected binding
        // must never serve as evidence for this prompt's incarnation.
        or(
          isNull(executionEvents.runSessionIncarnationId),
          eq(executionEvents.runSessionIncarnationId, incarnationId),
        ),
        eq(executionEvents.eventType, "session.crashed"),
        eq(executionEvents.ingestDisposition, "accepted"),
      ),
    )
    .limit(1);

  if (!crash || crash.sequence === null) {
    const details = command.lastError?.details;

    if (
      details !== null &&
      typeof details === "object" &&
      "reason" in details &&
      details.reason === "required_output_incomplete"
    )
      throw new PromptOwnerInvariantError(
        "session_terminal_evidence_unavailable",
      );

    return null;
  }

  return {
    eventId: crash.id,
    streamId: terminal.streamId,
    crashSequence: crash.sequence.toString(),
    terminalEventId: command.terminalEventId,
    terminalSequence: terminal.hostSequence.toString(),
  };
}

/** Caller owns the transaction. Prompt-owner application commits this with its
 * command marker; reattachment calls it before waiting on an already-applied
 * command. The same guards protect node and gate permission parks. */
export async function settleCrashedPermissionPark(
  tx: Db,
  input: Readonly<{
    runId: string;
    owner: ParkOwner;
    command: ExecutionCommand;
  }>,
): Promise<boolean> {
  const { runId, owner, command } = input;
  const ref = command.ownerRef;

  if (
    command.runId !== runId ||
    command.state !== "failed" ||
    isTurnLostError(command.lastError) ||
    !ref ||
    (ref.variant !== "node" &&
      ref.variant !== "permission_resume" &&
      ref.variant !== "gate_ai" &&
      ref.variant !== "gate_skill") ||
    ref.nodeAttemptId !== owner.nodeAttemptId ||
    ref.variant !== owner.variant ||
    ref.promptOrdinal !== owner.promptOrdinal ||
    !ref.incarnationId ||
    !(await childCrashPrecededTerminal(tx, command))
  )
    return false;

  const [run] = await tx
    .select({
      runKind: runs.runKind,
      status: runs.status,
      currentStepId: runs.currentStepId,
      executionAssignmentId: runs.executionAssignmentId,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .for("update");
  const [attempt] = await tx
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.id, owner.nodeAttemptId))
    .for("update");
  const [incarnation] = await tx
    .select({
      runId: runSessionIncarnations.runId,
      assignmentId: runSessionIncarnations.executionAssignmentId,
      hostSessionId: runSessionIncarnations.hostSessionId,
    })
    .from(runSessionIncarnations)
    .where(eq(runSessionIncarnations.id, ref.incarnationId));

  if (
    run?.runKind !== "flow" ||
    run.status !== "NeedsInput" ||
    run.executionAssignmentId !== command.executionAssignmentId ||
    !attempt ||
    attempt.runId !== runId ||
    attempt.endedAt !== null ||
    run.currentStepId !== attempt.nodeId ||
    attempt.executionAssignmentId !== command.executionAssignmentId ||
    incarnation?.runId !== runId ||
    incarnation.assignmentId !== command.executionAssignmentId ||
    incarnation.hostSessionId !== command.targetSessionId
  )
    return false;

  const gate = owner.variant === "gate_ai" || owner.variant === "gate_skill";
  const [evaluation] = gate
    ? await tx
        .select()
        .from(gateResults)
        .where(eq(gateResults.id, owner.evaluationId))
        .for("update")
    : [];

  if (gate) {
    if (
      !evaluation ||
      evaluation.runId !== runId ||
      evaluation.nodeAttemptId !== attempt.id ||
      evaluation.gateId !== owner.gateId ||
      evaluation.promptOrdinal !== owner.promptOrdinal ||
      evaluation.kind !==
        (owner.variant === "gate_ai" ? "ai_judgment" : "skill_check") ||
      evaluation.status !== "running" ||
      attempt.actionCompletion?.result.ok !== true ||
      !(ref.variant === "gate_ai" || ref.variant === "gate_skill") ||
      ref.evaluationId !== evaluation.id ||
      ref.gateId !== evaluation.gateId
    )
      return false;
  } else if (
    command.applicationState !== "applied" ||
    attempt.actionCompletion?.commandId !== command.id ||
    attempt.actionCompletion.result.ok !== false
  )
    return false;

  try {
    await closeTurnLostAttempt(tx, {
      runId,
      nodeAttemptId: attempt.id,
      reason: "session-crashed",
      causeSource: "graph",
      fromStatuses: ["NeedsInput"],
      fromAttemptStatuses: [attempt.status],
      admitCompletedAction: true,
    });
  } catch (error) {
    if (error instanceof TurnLostCasLost) return false;
    throw error;
  }
  if (evaluation) await markGateStale(evaluation.id, tx);
  log.warn(
    {
      runId,
      nodeAttemptId: attempt.id,
      commandId: command.id,
      incarnationId: ref.incarnationId,
      evaluationId: evaluation?.id ?? null,
    },
    "flow-permission-park-session-crashed",
  );

  return true;
}
