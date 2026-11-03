import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  AgentTurn,
  ExecutionAssignment,
  ExecutionCommand,
} from "@/lib/db/schema";

import { and, eq, inArray, isNotNull, or } from "drizzle-orm";

import { isSessionCreateQuiescence } from "../../../runtime/session-create-quiescence";

import { lockAgentPermissionResult } from "./permission-result";

import {
  executionCommands,
  executionAssignments,
  executionHosts,
  agentTurns,
  runs,
  runSessionIncarnations,
  runSessions,
} from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { projectCanonicalSessionLifecycle } from "@/lib/execution-host/events/lifecycle-projector";
import { lockCurrentSessionAssignment } from "@/lib/execution-host/session-binding";
import { readCreateIntent } from "@/lib/execution-host/create-intent";
import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";

type AgentExecutionIdentity = Readonly<{
  id: string;
  executionAssignmentId: string | null;
}>;

/** A host's durable refusal proves no session existed only for this exact owned generation. */
export async function hasRejectedAgentCreateEvidence(
  db: Db,
  run: AgentExecutionIdentity,
): Promise<boolean> {
  if (!run.executionAssignmentId) return false;
  const [binding] = await db
    .select({
      assignment: executionAssignments,
      hostKey: executionHosts.hostKey,
    })
    .from(executionAssignments)
    .innerJoin(
      executionHosts,
      eq(executionHosts.id, executionAssignments.executionHostId),
    )
    .innerJoin(
      runs,
      and(
        eq(runs.id, executionAssignments.runId),
        eq(runs.executionAssignmentId, executionAssignments.id),
      ),
    )
    .where(
      and(
        eq(executionAssignments.id, run.executionAssignmentId),
        eq(executionAssignments.runId, run.id),
      ),
    );

  if (!binding) return false;
  const commands = await db
    .select()
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, run.id),
        inArray(executionCommands.kind, [
          "session.create",
          "session.prompt",
          "session.steer",
        ]),
      ),
    );
  const incarnations = await db
    .select({ id: runSessionIncarnations.id })
    .from(runSessionIncarnations)
    .where(eq(runSessionIncarnations.runId, run.id))
    .limit(1);
  const dispatch = await readAgentDispatchEvidence(db, run.id);

  if (!commands.length || incarnations.length || dispatch.hasBoundSession)
    return false;
  for (const command of commands) {
    const turn = await readRejectedAgentCreateOwner(db, command, binding);

    if (
      !turn ||
      turn.commandId !== null ||
      !["claimed", "superseded"].includes(turn.state)
    )
      return false;
  }

  return true;
}

async function readRejectedAgentCreateOwner(
  db: Db,
  command: ExecutionCommand,
  binding: Readonly<{ assignment: ExecutionAssignment; hostKey: string }>,
): Promise<AgentTurn | null> {
  const receipt = command.receiptEvidence;
  const details = receipt?.body.details;
  const quiescence =
    details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>).sessionCreateQuiescence
      : undefined;

  if (
    command.kind !== "session.create" ||
    command.state !== "failed" ||
    command.executionAssignmentId !== binding.assignment.id ||
    command.assignmentEpoch !== binding.assignment.epoch ||
    !receipt ||
    receipt.commandId !== command.id ||
    receipt.runId !== command.runId ||
    command.runId !== binding.assignment.runId ||
    command.executionHostId !== binding.assignment.executionHostId ||
    receipt.kind !== "session.create" ||
    receipt.assignmentEpoch !== binding.assignment.epoch ||
    receipt.phase !== "rejected" ||
    receipt.inflight ||
    receipt.httpStatus < 400 ||
    receipt.httpStatus > 599 ||
    (!receipt.completedAt && !receipt.evidenceV2?.terminal) ||
    !isSessionCreateQuiescence(quiescence) ||
    (receipt.evidenceV2 !== undefined &&
      (receipt.evidenceV2.hostKey !== binding.hostKey ||
        receipt.evidenceV2.assignmentId !== binding.assignment.id))
  )
    return null;
  const { intent } = readCreateIntent(command, binding.hostKey);

  if (intent.owner.variant !== "agent") return null;
  const [turn] = await db
    .select()
    .from(agentTurns)
    .where(eq(agentTurns.id, intent.owner.turnId));

  if (
    !turn ||
    turn.runId !== command.runId ||
    turn.executionAssignmentId !== binding.assignment.id ||
    turn.assignmentEpoch !== binding.assignment.epoch ||
    turn.ordinal !== intent.owner.promptOrdinal
  )
    return null;

  return turn;
}

/** A fresh qualification may follow completed model work, but cannot hide an unproven failed spawn. */
export async function hasUnprovenAgentCreateFailure(
  db: Db,
  runId: string,
): Promise<boolean> {
  const failures = await db
    .select()
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, runId),
        eq(executionCommands.kind, "session.create"),
        eq(executionCommands.state, "failed"),
      ),
    );

  for (const command of failures) {
    const [binding] = await db
      .select({
        assignment: executionAssignments,
        hostKey: executionHosts.hostKey,
      })
      .from(executionAssignments)
      .innerJoin(
        executionHosts,
        eq(executionHosts.id, executionAssignments.executionHostId),
      )
      .where(
        and(
          eq(executionAssignments.id, command.executionAssignmentId),
          eq(executionAssignments.runId, runId),
        ),
      );

    if (!binding || !(await readRejectedAgentCreateOwner(db, command, binding)))
      return true;
  }

  return false;
}

/** Admission and bound handles independently disprove an unstarted Run. */
export async function readAgentDispatchEvidence(
  db: Db,
  runId: string,
): Promise<Readonly<{ hasOwnedCommand: boolean; hasBoundSession: boolean }>> {
  const [command] = await db
    .select({ id: executionCommands.id })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, runId),
        inArray(executionCommands.kind, ["session.create", "session.prompt"]),
      ),
    )
    .limit(1);
  const [session] = await db
    .select({ id: runSessions.id })
    .from(runSessions)
    .where(
      and(
        eq(runSessions.runId, runId),
        or(
          isNotNull(runSessions.acpSessionId),
          isNotNull(runSessions.hostSessionId),
        ),
      ),
    )
    .limit(1);

  return {
    hasOwnedCommand: command !== undefined,
    hasBoundSession: session !== undefined,
  };
}

/** Cancellation before the first create is serialized with create admission. */
export async function assertAgentCancellationBindingsQuiescent(
  db: Db,
  run: AgentExecutionIdentity,
): Promise<void> {
  if (!run.executionAssignmentId) return;
  const assignment = await lockCurrentSessionAssignment(db, {
    runId: run.id,
    assignmentId: run.executionAssignmentId,
  });

  if (assignment?.placementReason === "launch" && assignment.epoch === 1) {
    const [incarnation] = await db
      .select({ id: runSessionIncarnations.id })
      .from(runSessionIncarnations)
      .where(
        and(
          eq(runSessionIncarnations.runId, run.id),
          eq(runSessionIncarnations.executionAssignmentId, assignment.id),
        ),
      )
      .limit(1);
    const evidence = await readAgentDispatchEvidence(db, run.id);

    if (!incarnation && !evidence.hasOwnedCommand && !evidence.hasBoundSession)
      return;
  }

  await assertAgentSessionBindingsQuiescent(db, run);
}

/** A missing host session alone never proves that an owned process exited. */
export async function assertAgentSessionBindingsQuiescent(
  db: Db,
  run: AgentExecutionIdentity,
  applicationCommandId?: string,
): Promise<void> {
  if (!run.executionAssignmentId) return;
  const incarnations = await db
    .select({
      id: runSessionIncarnations.id,
      state: runSessionIncarnations.state,
    })
    .from(runSessionIncarnations)
    .where(
      and(
        eq(runSessionIncarnations.runId, run.id),
        eq(
          runSessionIncarnations.executionAssignmentId,
          run.executionAssignmentId,
        ),
      ),
    );

  // A result-resume grant has no successor session. Its exact retained prompt
  // and confirmed predecessor teardown are checked again under the apply lock.
  if (
    incarnations.length === 0 &&
    applicationCommandId &&
    (await lockAgentPermissionResult(db, run.id, applicationCommandId))
  )
    return;
  if (
    incarnations.length === 0 &&
    (await hasRejectedAgentCreateEvidence(db, run))
  )
    return;
  if (
    incarnations.length === 0 ||
    incarnations.some(
      ({ state }) =>
        state !== "exited" && state !== "crashed" && state !== "checkpointed",
    )
  )
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Agent execution has no confirmed terminal lifecycle; reconcile the original session before finalizing",
      {
        details: {
          reason: "agent_execution_quiescence_unproven",
          runId: run.id,
          assignmentId: run.executionAssignmentId,
          incarnations,
        },
      },
    );
}

/** Canonical exit evidence and a fresh host observation must agree. */
export async function assertAgentExecutionQuiescent(
  db: Db,
  run: AgentExecutionIdentity,
  applicationCommandId?: string,
): Promise<void> {
  if (!run.executionAssignmentId) return;
  await projectCanonicalSessionLifecycle({ db, runId: run.id });
  await assertAgentSessionBindingsQuiescent(db, run, applicationCommandId);
  await assertNoLiveAgentSessions(db, run);
}

/** An unstarted cancellation still requires a fresh host observation. */
export async function assertAgentCancellationExecutionQuiescent(
  db: Db,
  run: AgentExecutionIdentity,
): Promise<void> {
  if (!run.executionAssignmentId) return;
  await projectCanonicalSessionLifecycle({ db, runId: run.id });
  await assertAgentCancellationBindingsQuiescent(db, run);
  await assertNoLiveAgentSessions(db, run);
}

/** Await canonical teardown outside a transaction. Wakes are process-local,
 * so the absolute monotonic deadline always performs a final durable read.
 * A successful DELETE or missing inventory never substitutes for that proof.
 */
export async function waitForAgentCancellationExecutionQuiescent(
  db: Db,
  run: AgentExecutionIdentity,
  deadline: number,
): Promise<void> {
  for (;;) {
    const controller = new AbortController();
    // Subscribe before reading: an ingest commit during the read must not
    // leave this request sleeping until its deadline after a lost local wake.
    const wake = runEventWakeBus.wait(
      run.id,
      Math.max(0, deadline - performance.now()),
      controller.signal,
    );

    try {
      await assertAgentCancellationExecutionQuiescent(db, run);

      return;
    } catch (error) {
      if (
        !isMaisterError(error) ||
        error.details?.reason !== "agent_execution_quiescence_unproven" ||
        performance.now() >= deadline
      )
        throw error;
      await wake;
    } finally {
      controller.abort();
    }
  }
}

/** Terminal cleanup checks the retained assignment, including a first launch released before create. */
export async function assertTerminalAgentCleanupExecutionQuiescent(
  db: Db,
  run: AgentExecutionIdentity,
): Promise<void> {
  if (!run.executionAssignmentId) return;
  await projectCanonicalSessionLifecycle({ db, runId: run.id });
  const [assignment] = await db
    .select()
    .from(executionAssignments)
    .where(
      and(
        eq(executionAssignments.id, run.executionAssignmentId),
        eq(executionAssignments.runId, run.id),
      ),
    );

  if (!assignment || assignment.state !== "released")
    throw new MaisterError(
      "PRECONDITION",
      "Terminal agent cleanup requires its released execution assignment",
      {
        details: {
          reason: "agent_execution_quiescence_unproven",
          runId: run.id,
          assignmentId: run.executionAssignmentId,
        },
      },
    );
  const [incarnation] = await db
    .select({ id: runSessionIncarnations.id })
    .from(runSessionIncarnations)
    .where(
      and(
        eq(runSessionIncarnations.runId, run.id),
        eq(runSessionIncarnations.executionAssignmentId, assignment.id),
      ),
    )
    .limit(1);
  const evidence = await readAgentDispatchEvidence(db, run.id);

  if (
    assignment.placementReason !== "launch" ||
    assignment.epoch !== 1 ||
    incarnation ||
    evidence.hasOwnedCommand ||
    evidence.hasBoundSession
  )
    await assertAgentSessionBindingsQuiescent(db, run);
  await assertNoLiveAgentSessions(db, run);
}

async function assertNoLiveAgentSessions(
  db: Db,
  run: AgentExecutionIdentity,
): Promise<void> {
  if (!run.executionAssignmentId) return;
  const client = await createExecutionHosts({ db }).forAssignment({
    id: run.executionAssignmentId,
  });
  const live = (await client.sessionsForRun()).filter(
    (session) => session.status === "live",
  );

  if (live.length > 0)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Agent execution still has live host sessions; no scheduler slot was released",
      {
        details: {
          reason: "agent_execution_not_quiescent",
          runId: run.id,
          assignmentId: run.executionAssignmentId,
          sessionIds: live.map((session) => session.sessionId),
        },
      },
    );
}
