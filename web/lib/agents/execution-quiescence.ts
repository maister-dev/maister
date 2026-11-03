import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq, inArray, isNotNull, or } from "drizzle-orm";

import { lockAgentPermissionResult } from "./permission-result";

import {
  executionCommands,
  executionAssignments,
  runSessionIncarnations,
  runSessions,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { projectCanonicalSessionLifecycle } from "@/lib/execution-host/events/lifecycle-projector";
import { lockCurrentSessionAssignment } from "@/lib/execution-host/session-binding";

type AgentExecutionIdentity = Readonly<{
  id: string;
  executionAssignmentId: string | null;
}>;

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
