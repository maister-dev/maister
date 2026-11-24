import "server-only";

import type { Run } from "@/lib/db/schema";
import type { Db } from "@/lib/execution-host/db";
import type { StopWorkbenchRunResult } from "@/lib/workbench-lifecycle/service";
import type { AddressedStopClaim } from "@/lib/execution-host/workspace-stop";

import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import pino from "pino";

import { authorizeCompanyRunUserAction } from "@/lib/agents/company-run-read-access";
import {
  prepareAgentRunFinalization,
  TERMINAL_CAS_SOURCE,
} from "@/lib/agents/finalization";
import { isCompanyFlowResource } from "@/lib/agents/operational-context";
import {
  assertAgentSessionBindingsQuiescent,
  assertAgentExecutionQuiescent,
} from "@/lib/agents/execution-quiescence";
import {
  companyFlowCanAbandon,
  finalizeCompanyFlowRun,
} from "@/lib/run-results/company-flow-terminal";
import { ensureCompanyUserActor } from "@/lib/assignments/service";
import { requireActiveSession, requireActiveUserById } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import {
  executionAssignments,
  executionCommands,
  runs,
  workspaces,
} from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { createExecutionHosts } from "@/lib/execution-host";
import { configuredSelectedExecutionEndpoint } from "@/lib/execution-host/selected-endpoint";
import { cascadeAbandonRunTreeAndStopSessions } from "@/lib/orchestrator/cascade";
import { CASCADE_NON_TERMINAL_RUN_STATUSES, getRunSubtreeIds } from "@/lib/queries/run";
import {
  addressedFlowStopStates,
  claimAddressedFlowStop,
  settleAddressedWorkloadStops,
} from "@/lib/execution-host/workspace-stop";
import { currentBudgetTermination } from "@/lib/runs/budget-termination";
import { promoteNextPending } from "@/lib/scheduler";
import { assertTaskLaunchUserAuthority } from "@/lib/tasks/launch-authority";
import {
  recordProjectRunStopped,
  stopWorkbenchRun,
  workbenchLifecycleDepsForUser,
} from "@/lib/workbench-lifecycle/service";

const log = pino({ name: "run-stop", level: process.env.LOG_LEVEL ?? "info" });

async function retireAddressedFlowExecution(
  db: Db,
  claim: AddressedStopClaim,
): Promise<boolean> {
  await assertTaskLaunchUserAuthority(db, claim.projectId, claim.requestedBy, ["recoverRun"]);
  await settleAddressedWorkloadStops(db, claim);
  const hosts = createExecutionHosts({ db });
  const client = await hosts.forAssignment({ id: claim.assignmentId });
  let supervisorStopped = claim.commands.length > 0;
  for (const session of await client.sessionsForRun()) {
    if (session.status !== "live") continue;
    await assertTaskLaunchUserAuthority(db, claim.projectId, claim.requestedBy, [
      "recoverRun",
    ]);
    await client.deleteSession(session.sessionId);
    supervisorStopped = true;
  }
  const identity = { id: claim.runId, executionAssignmentId: claim.assignmentId };
  await assertAgentExecutionQuiescent(db, identity, undefined, hosts);
  return supervisorStopped;
}

async function retireAddressedChild(
  db: Db,
  child: Run,
  userId: string,
): Promise<void> {
  const [assignment] = child.executionAssignmentId
    ? await db.select().from(executionAssignments).where(eq(executionAssignments.id, child.executionAssignmentId))
    : [];
  if (assignment?.state === "active") {
    const claim = await claimAddressedFlowStop(db, child.id, userId);
    if (!claim.alreadyStopped) await retireAddressedFlowExecution(db, claim);
    return;
  }
  await assertAgentExecutionQuiescent(db, child);
  if (assignment) {
    const [uncertain] = await db.select({ id: executionCommands.id })
      .from(executionCommands).where(and(
        eq(executionCommands.executionAssignmentId, assignment.id),
        eq(executionCommands.kind, "workspace.run"),
        sql`(${executionCommands.result}->>'quiescence' IS DISTINCT FROM 'proved'
          AND ${executionCommands.state} NOT IN ('failed', 'fenced'))`,
      )).limit(1);
    if (uncertain)
      throw new MaisterError("CONFLICT", "An addressed child still needs workload retirement evidence",
        { details: { reason: "addressed_stop_pending", runId: child.id } });
  }
}

async function stopAddressedFlowForUser(
  db: Db,
  userId: string,
  runId: string,
): Promise<StopWorkbenchRunResult> {
  const claim = await claimAddressedFlowStop(db, runId, userId);
  if (claim.alreadyStopped)
    return { ok: true, runId, runStatus: "Review", supervisorStopped: false };
  await cascadeAbandonRunTreeAndStopSessions(runId, claim.taskId, "user_stopped", {
    db,
    logLabel: "[addressed-stop]",
    confirmAddressedChildRetirement: (child) => retireAddressedChild(db, child, claim.requestedBy),
  });
  const supervisorStopped = await retireAddressedFlowExecution(db, claim);
  const identity = { id: runId, executionAssignmentId: claim.assignmentId };
  await db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .for("no key update");
    if (
      !run ||
      run.executionAssignmentId !== claim.assignmentId ||
      run.projectId !== claim.projectId
    )
      throw new MaisterError(
        "CONFLICT",
        "Addressed Stop lost its Run assignment",
        {
          details: { reason: "addressed_stop_owner_changed" },
        },
      );
    const [assignment] = await tx
      .select()
      .from(executionAssignments)
      .where(eq(executionAssignments.id, claim.assignmentId))
      .for("no key update");
    await assertTaskLaunchUserAuthority(tx, claim.projectId, claim.requestedBy, [
      "recoverRun",
    ]);
    if (
      run.status === "Review" &&
      assignment?.state === "released" &&
      assignment.releasedReason === "stopped"
    )
      return;
    if (!assignment?.addressedStopRequestedAt || assignment.state !== "active")
      throw new MaisterError(
        "CONFLICT",
        "The addressed Stop is no longer active",
        {
          details: { reason: "addressed_stop_owner_changed" },
        },
      );
    const descendants = await getRunSubtreeIds(runId, tx);
    const [child] = descendants.length ? await tx.select({ id: runs.id }).from(runs)
      .where(and(inArray(runs.id, descendants), inArray(runs.status, CASCADE_NON_TERMINAL_RUN_STATUSES))).limit(1) : [];
    if (child) throw new MaisterError("CONFLICT", "An addressed child still needs retirement",
      { details: { reason: "addressed_stop_pending", runId: child.id } });
    await assertAgentSessionBindingsQuiescent(tx, identity);
    await recordProjectRunStopped(tx, {
      runId,
      endedAt: new Date(),
      reason: "run stopped by operator",
      addressedOwner: { assignmentId: claim.assignmentId, status: run.status },
    });
  });
  try {
    await promoteNextPending({ db });
  } catch (error) {
    log.error(
      { runId, errorType: error instanceof Error ? error.name : typeof error },
      "scheduler admission after addressed Stop failed",
    );
  }

  return { ok: true, runId, runStatus: "Review", supervisorStopped };
}

/** Resume one durable operator Stop after the normal command worker has obtained proof. */
export async function recoverAddressedFlowStop(db: Db): Promise<void> {
  if (!configuredSelectedExecutionEndpoint()) return;
  const [ready] = await db
    .select({
      runId: runs.id,
      userId: executionAssignments.addressedStopRequestedBy,
    })
    .from(executionAssignments)
    .innerJoin(
      runs,
      and(
        eq(runs.id, executionAssignments.runId),
        eq(runs.executionAssignmentId, executionAssignments.id),
      ),
    )
    .where(
      and(
        eq(executionAssignments.state, "active"),
        isNotNull(executionAssignments.addressedStopRequestedAt),
        inArray(runs.status, addressedFlowStopStates),
        sql`NOT EXISTS (
          WITH RECURSIVE ancestors AS (
            SELECT id,parent_run_id,execution_assignment_id FROM runs WHERE id=${runs.parentRunId}
            UNION
            SELECT parent.id,parent.parent_run_id,parent.execution_assignment_id
            FROM runs parent JOIN ancestors child ON parent.id=child.parent_run_id
          )
          SELECT 1 FROM ancestors
          JOIN execution_assignments owner ON owner.id=ancestors.execution_assignment_id
          WHERE owner.state='active' AND owner.addressed_stop_requested_at IS NOT NULL
        )`,
        sql`NOT EXISTS (SELECT 1 FROM ${executionCommands} command
      WHERE command.execution_assignment_id = ${executionAssignments.id}
      AND ((command.kind = 'workspace.cancel' AND command.state <> 'succeeded')
        OR (command.kind IN ('session.create', 'workspace.prepare', 'workspace.materialize', 'workspace.checkpoint', 'workspace.restore')
          AND command.state IN ('queued', 'delivering', 'accepted'))))`,
      ),
    )
    .orderBy(
      asc(executionAssignments.addressedStopRequestedAt),
      asc(executionAssignments.id),
    )
    .limit(1);
  if (ready?.userId)
    await stopAddressedFlowForUser(db, ready.userId, ready.runId);
}

async function authorizeCompanyStop(
  db: Db,
  userId: string,
  runId: string,
): Promise<Run> {
  try {
    return await db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, runId))
        .for("update");

      if (!run || run.companyId === null)
        throw new MaisterError("PRECONDITION", "Run is unavailable", {
          details: { reason: "run_not_found" },
        });
      await authorizeCompanyRunUserAction(
        tx,
        userId,
        runId,
        "assignments:cancel",
      );
      if (
        run.status !== "Abandoned" &&
        !(isCompanyFlowResource(run)
          ? companyFlowCanAbandon(run.status)
          : TERMINAL_CAS_SOURCE.Abandoned.includes(run.status))
      )
        throw new MaisterError(
          "CONFLICT",
          "The company Run is not in a cancellable state",
          {
            details: { reason: "company_run_not_cancellable" },
          },
        );

      return run;
    });
  } catch (error) {
    if (isMaisterError(error) && error.details?.reason === "run_unavailable")
      throw new MaisterError("PRECONDITION", "Run is unavailable", {
        details: { reason: "run_not_found" },
      });
    throw error;
  }
}

/** Retain current authorized cancellation before any host effects. */
export async function claimCompanyStop(
  db: Db,
  userId: string,
  runId: string,
): Promise<Run> {
  return db.transaction(async (tx) => {
    const run = await authorizeCompanyStop(tx, userId, runId);

    if (run.status === "Abandoned") return run;
    if (await currentBudgetTermination(tx, run))
      throw new MaisterError(
        "CONFLICT",
        "A budget termination already owns this company Run; reconcile its retained stop before requesting another cancellation",
        { details: { reason: "budget_termination_pending" } },
      );
    if (run.companyCancellationIntent) {
      if (run.companyCancellationIntent.userId !== userId)
        throw new MaisterError(
          "CONFLICT",
          "Company Run cancellation is owned by another operator; reconcile the retained stop intent",
          { details: { reason: "company_stop_owned" } },
        );

      return run;
    }
    const [claimed] = await tx
      .update(runs)
      .set({
        companyCancellationIntent: {
          version: 1,
          userId,
          requestedAt: new Date().toISOString(),
          assignmentId: run.executionAssignmentId,
          driverToken: run.flowDriverToken,
        },
      })
      .where(eq(runs.id, runId))
      .returning();

    log.info(
      {
        runId,
        companyId: run.companyId,
        userId,
        assignmentId: run.executionAssignmentId,
      },
      "company cancellation intent retained before session teardown",
    );

    return claimed;
  });
}

/** Owner dispatch reuses the operational cancellation and project lifecycle owners. */
export async function stopRun(runId: string): Promise<StopWorkbenchRunResult> {
  return stopRunForUser((await requireActiveSession()).id, runId);
}

/** The same stop for a principal a token or caller has already authenticated. */
export async function stopRunForUser(
  userId: string,
  runId: string,
): Promise<StopWorkbenchRunResult> {
  const user = await requireActiveUserById(userId);
  const db: Db = getDb();
  const [owner] = await db
    .select({
      companyId: runs.companyId,
      runKind: runs.runKind,
      workspaceOwnership: workspaces.ownershipKind,
    })
    .from(runs)
    .leftJoin(
      workspaces,
      and(eq(workspaces.runId, runs.id), isNull(workspaces.removedAt)),
    )
    .where(eq(runs.id, runId));

  if (
    owner?.companyId === null &&
    owner.runKind === "flow" &&
    owner.workspaceOwnership === "host_owned"
  )
    return stopAddressedFlowForUser(db, user.id, runId);
  if (owner?.companyId == null)
    return stopWorkbenchRun(runId, {
      deps: workbenchLifecycleDepsForUser(user.id),
    });
  const run = await claimCompanyStop(db, user.id, runId);

  if (run.status === "Abandoned")
    return {
      ok: true,
      runId,
      runStatus: "Abandoned",
      supervisorStopped: false,
    };
  let supervisorStopped = false;

  if (run.executionAssignmentId) {
    const client = await createExecutionHosts({ db }).forAssignment({
      id: run.executionAssignmentId,
    });

    for (const session of await client.sessionsForRun()) {
      if (session.status !== "live") continue;
      await authorizeCompanyStop(db, user.id, runId);
      await client.deleteSession(session.sessionId);
      supervisorStopped = true;
    }
  }
  let finalized: boolean;

  if (isCompanyFlowResource(run)) {
    try {
      finalized = await finalizeCompanyFlowRun({
        db,
        rootDb: db,
        runId,
        requested: "Abandoned",
        userId: user.id,
        errorCode: null,
        reason: "operator",
        driverToken: run.flowDriverToken ?? undefined,
      });
    } catch (error) {
      if (
        !isMaisterError(error) ||
        error.code !== "EXECUTOR_UNAVAILABLE" ||
        error.details?.reason !== "agent_execution_quiescence_unproven"
      )
        throw error;

      // A concurrent stop can finalize and release the assignment while this
      // request is proving quiescence against its earlier snapshot.
      const current = await authorizeCompanyStop(db, user.id, runId);

      if (
        current.status !== "Abandoned" ||
        current.companyCancellationIntent?.userId !== user.id
      )
        throw error;

      return { ok: true, runId, runStatus: "Abandoned", supervisorStopped };
    }
  } else {
    const actor = await ensureCompanyUserActor({
      db,
      companyId: owner.companyId,
      userId: user.id,
    });
    const prepared = await prepareAgentRunFinalization(runId, "Abandoned", {
      db,
      reason: "operator",
      closeOpenHitl: true,
      closeAssignments: {
        kind: "user",
        actorId: actor.id,
        eventKind: "cancelled",
        reason: "Company Run stopped by operator",
      },
    });
    const result = await db.transaction(async (tx) => {
      await authorizeCompanyStop(tx, user.id, runId);

      return prepared.apply(tx);
    });

    await prepared.afterCommit(result);
    finalized = result.finalized;
  }
  if (!finalized) {
    const current = await authorizeCompanyStop(db, user.id, runId);

    if (current.status !== "Abandoned")
      throw new MaisterError(
        "CONFLICT",
        "Company Run cancellation has not confirmed abandonment",
        {
          details: { reason: "agent_stop_finalization_pending" },
        },
      );
  }
  log.info(
    {
      runId,
      companyId: owner.companyId,
      userId: user.id,
      supervisorStopped,
      finalized,
    },
    "company Run stopped through native finalization",
  );

  return { ok: true, runId, runStatus: "Abandoned", supervisorStopped };
}
