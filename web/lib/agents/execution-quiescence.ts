import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  AgentTurn,
  ExecutionAssignment,
  ExecutionCommand,
} from "@/lib/db/schema";
import type { BoundClient, ExecutionHosts } from "@/lib/execution-host";

import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import pino from "pino";

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
import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";
import { RUNTIME_EVENT_CLAIM_LEASE_MS } from "@/lib/execution-host/events/consumer";
import { projectionLimitsFromEnv } from "@/lib/execution-host/events/projection-limits";
import { createExecutionHosts } from "@/lib/execution-host/client";
import {
  projectCanonicalSessionLifecycle,
  reconcileHistoricalAgentLifecycle,
} from "@/lib/execution-host/events/lifecycle-projector";
import {
  lockCurrentSessionAssignment,
  staleSessionBinding,
} from "@/lib/execution-host/session-binding";
import { readCreateIntent } from "@/lib/execution-host/create-intent";

const log = pino({
  name: "execution-quiescence",
  level: process.env.LOG_LEVEL ?? "info",
});

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

/** Check an exact assignment under the Run-first lock used by create admission. */
export async function lockUndispatchedAgentAssignment(
  tx: Db,
  run: AgentExecutionIdentity,
): Promise<boolean> {
  if (!run.executionAssignmentId) return false;
  const assignment = await lockCurrentSessionAssignment(tx, {
    runId: run.id,
    assignmentId: run.executionAssignmentId,
  });

  return (
    assignment !== null &&
    !(await hasAssignmentDispatchEvidence(tx, assignment))
  );
}

async function hasAssignmentDispatchEvidence(
  db: Db,
  assignment: Pick<ExecutionAssignment, "id" | "runId">,
): Promise<boolean> {
  // Treat incomplete ownership as evidence of a possible dispatch. The unfiltered
  // command read includes queued and retired records, which retain their identities.
  const [command] = await db
    .select({ id: executionCommands.id })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, assignment.runId),
        eq(executionCommands.executionAssignmentId, assignment.id),
        inArray(executionCommands.kind, ["session.create", "session.prompt"]),
        sql`NOT ((${executionCommands.state} = 'failed' AND ${executionCommands.attempts} = 0
          AND ${executionCommands.lastError}->>'reason' = 'addressed_stop_before_session_delivery') IS TRUE)`,
      ),
    )
    .limit(1);
  if (command) return true;

  const [incarnation] = await db
    .select({ id: runSessionIncarnations.id })
    .from(runSessionIncarnations)
    .where(
      and(
        eq(runSessionIncarnations.runId, assignment.runId),
        or(
          eq(runSessionIncarnations.executionAssignmentId, assignment.id),
          isNull(runSessionIncarnations.executionAssignmentId),
        ),
      ),
    )
    .limit(1);
  if (incarnation) return true;

  const [session] = await db
    .select({ id: runSessions.id })
    .from(runSessions)
    .where(
      and(
        eq(runSessions.runId, assignment.runId),
        or(
          eq(runSessions.executionAssignmentId, assignment.id),
          isNull(runSessions.executionAssignmentId),
        ),
        or(
          isNotNull(runSessions.acpSessionId),
          isNotNull(runSessions.hostSessionId),
        ),
      ),
    )
    .limit(1);

  return session !== undefined;
}

export async function assertAgentCancellationBindingsQuiescent(
  db: Db,
  run: AgentExecutionIdentity,
): Promise<void> {
  if (!run.executionAssignmentId) return;
  if (await lockUndispatchedAgentAssignment(db, run)) return;
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
    incarnations.length === 0 &&
    (await lockUndispatchedAgentAssignment(db, run))
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
  hosts?: ExecutionHosts,
): Promise<void> {
  if (!run.executionAssignmentId) return;
  await projectCanonicalSessionLifecycle({ db, runId: run.id });
  await assertAgentSessionBindingsQuiescent(db, run, applicationCommandId);
  await assertNoLiveAgentSessions(db, run, hosts);
}

/** Await durable exit projection after teardown without repeating a command or weakening terminal evidence. */
export async function waitForAgentExecutionQuiescence(
  db: Db,
  run: AgentExecutionIdentity,
  signal?: AbortSignal,
  hosts?: ExecutionHosts,
): Promise<void> {
  const deadline =
    performance.now() +
    RUNTIME_EVENT_CLAIM_LEASE_MS +
    projectionLimitsFromEnv().leaseMs;

  for (;;) {
    signal?.throwIfAborted();
    try {
      await assertAgentExecutionQuiescent(db, run, undefined, hosts);

      return;
    } catch (error) {
      if (
        !isMaisterError(error) ||
        error.code !== "EXECUTOR_UNAVAILABLE" ||
        error.details?.reason !== "agent_execution_quiescence_unproven"
      )
        throw error;
      if (performance.now() >= deadline) {
        log.warn(
          {
            runId: run.id,
            assignmentId: run.executionAssignmentId,
            reason: error.details.reason,
          },
          "canonical execution quiescence deadline exhausted",
        );
        throw error;
      }
      log.debug(
        {
          runId: run.id,
          assignmentId: run.executionAssignmentId,
          reason: error.details.reason,
        },
        "awaiting canonical execution quiescence wake",
      );
    }
    await runEventWakeBus.wait(
      run.id,
      Math.min(250, deadline - performance.now()),
      signal,
    );
  }
}

/** An unstarted cancellation still requires a fresh host observation. */
export async function assertAgentCancellationExecutionQuiescent(
  db: Db,
  run: AgentExecutionIdentity,
  hosts?: ExecutionHosts,
): Promise<void> {
  if (!run.executionAssignmentId) return;
  await projectCanonicalSessionLifecycle({ db, runId: run.id });
  await assertAgentCancellationBindingsQuiescent(db, run);
  await assertNoLiveAgentSessions(db, run, hosts);
}

/** Await canonical teardown outside a transaction. Wakes are process-local,
 * so the absolute monotonic deadline always performs a final durable read.
 * A successful DELETE or missing inventory never substitutes for that proof.
 */
export async function waitForAgentCancellationExecutionQuiescent(
  db: Db,
  run: AgentExecutionIdentity,
  deadline: number,
  hosts?: ExecutionHosts,
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
      await assertAgentCancellationExecutionQuiescent(db, run, hosts);

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

async function assertCurrentAgentTeardown(
  tx: Db,
  client: BoundClient,
): Promise<void> {
  const { id: assignmentId, runId, epoch } = client.assignment;
  const owner = await lockCurrentSessionAssignment(tx, { runId, assignmentId });

  if (owner?.epoch !== epoch) throw staleSessionBinding(runId, assignmentId);
}

export async function stopCurrentAgentExecution(
  db: Db,
  run: AgentExecutionIdentity,
  hosts: ExecutionHosts,
): Promise<boolean> {
  if (!run.executionAssignmentId) return false;
  const client = await hosts.forAssignment({ id: run.executionAssignmentId });
  await db.transaction((tx) => assertCurrentAgentTeardown(tx, client));

  let stopped = false;
  for (const session of await client.sessionsForRun()) {
    if (
      session.status !== "live" ||
      (session.assignmentId && session.assignmentId !== client.assignment.id) ||
      (session.assignmentEpoch != null &&
        session.assignmentEpoch !== client.assignment.epoch)
    )
      continue;
    await client.deleteSession(session.sessionId, {
      assertCommit: (tx) => assertCurrentAgentTeardown(tx, client),
    });
    stopped = true;
  }

  return stopped;
}

export async function assertHistoricalAgentAssignmentsQuiescent(
  db: Db,
  run: AgentExecutionIdentity,
  hosts: ExecutionHosts,
): Promise<void> {
  await reconcileHistoricalAgentLifecycle(db, run.id);
  const assignments = await db
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.runId, run.id));
  for (const assignment of assignments) {
    if (assignment.id === run.executionAssignmentId) continue;
    const identity = { id: run.id, executionAssignmentId: assignment.id };
    if (!(await hasAssignmentDispatchEvidence(db, assignment))) continue;
    await assertAgentSessionBindingsQuiescent(db, identity);
    await assertNoLiveAgentSessions(db, identity, hosts);
  }
}

/** Physical disposal requires terminal evidence for every dispatched assignment. */
export async function assertTerminalAgentCleanupExecutionQuiescent(
  db: Db,
  run: AgentExecutionIdentity,
  hosts?: ExecutionHosts,
): Promise<void> {
  if (!run.executionAssignmentId) return;
  await projectCanonicalSessionLifecycle({ db, runId: run.id });
  await reconcileHistoricalAgentLifecycle(db, run.id);
  const assignments = await db
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.runId, run.id));
  if (assignments.some((assignment) => assignment.state === "active"))
    throw new MaisterError(
      "PRECONDITION",
      "Terminal agent cleanup requires released execution assignments",
      {
        details: {
          reason: "agent_execution_quiescence_unproven",
          runId: run.id,
        },
      },
    );

  const observedHosts = new Set<string>();
  for (const assignment of assignments) {
    const identity = { id: run.id, executionAssignmentId: assignment.id };
    if (await hasAssignmentDispatchEvidence(db, assignment))
      await assertAgentSessionBindingsQuiescent(db, identity);
    if (observedHosts.has(assignment.executionHostId)) continue;
    await assertNoLiveAgentSessions(db, identity, hosts);
    observedHosts.add(assignment.executionHostId);
  }
}

async function assertNoLiveAgentSessions(
  db: Db,
  run: AgentExecutionIdentity,
  hosts?: ExecutionHosts,
): Promise<void> {
  if (!run.executionAssignmentId) return;
  const client = await (hosts ?? createExecutionHosts({ db })).forAssignment({
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
