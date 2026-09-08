import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ScratchDialogStatus } from "@/lib/db/schema";

import { eq, sql } from "drizzle-orm";
import pino from "pino";

import {
  dialogStatusAfterPromptCompletion,
  runStatusForDialogStatus,
} from "./state";

import { runs, scratchRuns } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

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
    .set({ dialogStatus: nextStatus, updatedAt: new Date() })
    .where(eq(scratchRuns.runId, runId));
  await tx
    .update(runs)
    .set({ status: runStatusForDialogStatus(nextStatus) })
    .where(eq(runs.id, runId));
  log.info(
    { runId, previousStatus: previous, nextStatus },
    "scratch prompt completion transitioned idle",
  );

  return nextStatus;
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
