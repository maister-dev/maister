import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { RunStatus, ScratchDialogStatus } from "@/lib/db/schema";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import { isTerminalScratchDialogStatus } from "./state";
import { lockScratchRunRows } from "./turn-completion";

import { hitlRequests, runs, scratchRuns } from "@/lib/db/schema";
import { closedAnswerResponse } from "@/lib/hitl-closed-answer";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "scratch-open-permissions",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Repair terminal replay under the same fence as Recover and Stop. A run
 * that resumed before this lock is acquired retains its live permissions. */
export async function closeTerminalScratchPermissions(
  db: Db,
  runId: string,
): Promise<
  Readonly<{
    runStatus: RunStatus;
    dialogStatus: ScratchDialogStatus;
  }>
> {
  return db.transaction(async (tx) => {
    await lockScratchRunRows(tx, runId);
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
    const [scratch] = await tx
      .select()
      .from(scratchRuns)
      .where(eq(scratchRuns.runId, runId));

    if (!run || !scratch)
      throw new MaisterError(
        "PRECONDITION",
        "scratch terminal replay lost its run",
        {
          details: { runId },
        },
      );
    if (isTerminalScratchDialogStatus(scratch.dialogStatus))
      await closeOpenScratchPermissions(tx, runId, new Date());

    return { runStatus: run.status, dialogStatus: scratch.dialogStatus };
  });
}

/** Closes every open permission request of a scratch run, a stored answer or
 * not — the close-out every terminal writer of a scratch dialog shares. The
 * terminal owns an answer its dead session never received (ADR-177
 * 2026-09-26), so a Recover's fresh session asks again instead of inheriting a
 * choice made for a request that no longer exists. */
export async function closeOpenScratchPermissions(
  tx: Db,
  runId: string,
  at: Date,
): Promise<number> {
  const closed = await tx
    .update(hitlRequests)
    .set({
      respondedAt: at,
      response: closedAnswerResponse("session_ended", at),
    })
    .where(
      and(
        eq(hitlRequests.runId, runId),
        eq(hitlRequests.kind, "permission"),
        isNull(hitlRequests.respondedAt),
        isNull(hitlRequests.supersededAt),
      ),
    )
    .returning({ id: hitlRequests.id });

  if (closed.length > 0)
    log.info(
      { runId, count: closed.length },
      "scratch-open-permissions-closed",
    );

  return closed.length;
}
