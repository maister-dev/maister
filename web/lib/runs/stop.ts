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
import { ensureCompanyUserActor } from "@/lib/assignments/service";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { createExecutionHosts } from "@/lib/execution-host";
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

/** Owner dispatch reuses the operational cancellation and project lifecycle owners. */
export async function stopRun(runId: string): Promise<StopWorkbenchRunResult> {
  const user = await requireActiveSession();
  const db: Db = getDb();
  const [owner] = await db
    .select({ companyId: runs.companyId })
    .from(runs)
    .where(eq(runs.id, runId));

  if (owner?.companyId == null) return stopWorkbenchRun(runId);
  const run = await authorizeCompanyStop(db, user.id, runId);

  if (run.status === "Abandoned")
    return {
      ok: true,
      runId,
      runStatus: "Abandoned",
      supervisorStopped: false,
    };
  const actor = await ensureCompanyUserActor({
    db,
    companyId: owner.companyId,
    userId: user.id,
  });
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
  if (!result.finalized) {
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
      finalized: result.finalized,
    },
    "company Run stopped through native finalization",
  );

  return { ok: true, runId, runStatus: "Abandoned", supervisorStopped };
}
