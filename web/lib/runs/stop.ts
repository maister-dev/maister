import "server-only";

import type { Run } from "@/lib/db/schema";
import type { Db } from "@/lib/execution-host/db";
import type { StopWorkbenchRunResult } from "@/lib/workbench-lifecycle/service";

import { eq } from "drizzle-orm";
import pino from "pino";

import { authorizeCompanyRunUserAction } from "@/lib/agents/company-run-read-access";
import {
  prepareAgentRunFinalization,
  TERMINAL_CAS_SOURCE,
} from "@/lib/agents/finalization";
import { isCompanyFlowResource } from "@/lib/agents/operational-context";
import { finalizeCompanyFlowRun } from "@/lib/run-results/company-flow-terminal";
import { ensureCompanyUserActor } from "@/lib/assignments/service";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { createExecutionHosts } from "@/lib/execution-host";
import { currentBudgetTermination } from "@/lib/runs/budget-termination";
import { stopWorkbenchRun } from "@/lib/workbench-lifecycle/service";

const log = pino({ name: "run-stop", level: process.env.LOG_LEVEL ?? "info" });

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
        !TERMINAL_CAS_SOURCE.Abandoned.includes(run.status)
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
  const user = await requireActiveSession();
  const db: Db = getDb();
  const [owner] = await db
    .select({ companyId: runs.companyId })
    .from(runs)
    .where(eq(runs.id, runId));

  if (owner?.companyId == null) return stopWorkbenchRun(runId);
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
