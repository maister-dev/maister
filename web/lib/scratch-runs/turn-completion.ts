import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ScratchDialogStatus } from "@/lib/db/schema";

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import pino from "pino";

import {
  dialogStatusAfterPromptCompletion,
  runStatusForDialogStatus,
} from "./state";

import { hitlRequests, runs, scratchRuns } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { loadActiveRunSession } from "@/lib/runs/active-run-session";
import { closedAnswerResponse } from "@/lib/hitl-closed-answer";

const log = pino({
  name: "scratch-turn-completion",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function lockScratchRunRows(tx: Db, runId: string): Promise<void> {
  await tx.execute(sql`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`);
  await tx.execute(
    sql`SELECT run_id FROM scratch_runs WHERE run_id = ${runId} FOR UPDATE`,
  );
}

/** DB-only; a prompt owner commits it with its command application marker. */
export async function applyScratchPromptCompletion(
  tx: Db,
  runId: string,
): Promise<ScratchDialogStatus> {
  await lockScratchRunRows(tx, runId);
  const [scratch] = await tx
    .select()
    .from(scratchRuns)
    .where(eq(scratchRuns.runId, runId));

  if (!scratch)
    throw new MaisterError(
      "PRECONDITION",
      `scratch metadata not found: ${runId}`,
    );
  const previous = scratch.dialogStatus as ScratchDialogStatus;
  const nextStatus = dialogStatusAfterPromptCompletion(previous);

  if (nextStatus === previous) {
    log.info(
      { runId, dialogStatus: nextStatus },
      "scratch prompt completion preserved event-derived status",
    );

    return nextStatus;
  }
  await tx
    .update(scratchRuns)
    .set({
      dialogStatus: nextStatus,
      activePromptIntent: null,
      updatedAt: new Date(),
    })
    .where(eq(scratchRuns.runId, runId));
  // The turn's host effect is settled, so it no longer anchors the reconcile
  // grace window; the next send or dispatch stamps a fresh one.
  await tx
    .update(runs)
    .set({
      status: runStatusForDialogStatus(nextStatus),
      resumeStartedAt: null,
    })
    .where(eq(runs.id, runId));
  log.info(
    { runId, previousStatus: previous, nextStatus },
    "scratch prompt completion transitioned idle",
  );
  await closeAnswersOfEarlierSessions(tx, runId);

  return nextStatus;
}

// A turn resumed after a host park re-prompts the interrupted turn, and the
// agent may finish it without raising the permission again — a scratch reply is
// the answer. The answer stored for the parked session then has nothing left
// to deliver to: close it (the response is kept as the record).
async function closeAnswersOfEarlierSessions(
  tx: Db,
  runId: string,
): Promise<void> {
  const session = await loadActiveRunSession(tx, runId);

  if (!session?.hostSessionId) return;
  const at = new Date();
  const closed = await tx
    .update(hitlRequests)
    .set({
      respondedAt: at,
      response: closedAnswerResponse("not_requested", at),
    })
    .where(
      and(
        eq(hitlRequests.runId, runId),
        eq(hitlRequests.kind, "permission"),
        isNotNull(hitlRequests.response),
        isNull(hitlRequests.respondedAt),
        isNull(hitlRequests.supersededAt),
        sql`${hitlRequests.schema}->>'supervisorSessionId' IS DISTINCT FROM ${session.hostSessionId}`,
      ),
    )
    .returning({ id: hitlRequests.id });

  for (const row of closed)
    log.warn(
      { runId, hitlRequestId: row.id },
      "scratch-idle-resume-completed-without-permission",
    );
}

export async function readScratchDialogStatus(
  db: Db,
  runId: string,
): Promise<ScratchDialogStatus> {
  const [scratch] = await db
    .select({ dialogStatus: scratchRuns.dialogStatus })
    .from(scratchRuns)
    .where(eq(scratchRuns.runId, runId));

  if (!scratch)
    throw new MaisterError(
      "PRECONDITION",
      `scratch metadata not found: ${runId}`,
    );

  return scratch.dialogStatus as ScratchDialogStatus;
}
