import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";

import { setTimeout as delay } from "node:timers/promises";

import { sql } from "drizzle-orm";
import pino from "pino";

import { MaisterError } from "@/lib/errors";
import { queryErrorDiagnostics } from "@/lib/db/pg-error";

const log = pino({
  name: "specialist-executor-lease",
  level: process.env.LOG_LEVEL ?? "info",
});

function lostExecutor(runId: string, placementId: string): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "The specialist executor lease was lost",
    {
      details: {
        reason: "assignment_fenced",
        runId,
        assignmentId: placementId,
      },
    },
  );
}

export async function beginSpecialistExecutor(
  db: SqlTransaction,
  runId: string,
  placementId: string,
): Promise<number | null> {
  const [result] = (
    await db.execute(
      sql`SELECT begin_specialist_executor(${runId},${placementId}) AS epoch`,
    )
  ).rows;

  if (result?.epoch === null) return null;
  if (typeof result?.epoch !== "number" || result.epoch < 1)
    throw lostExecutor(runId, placementId);

  return result.epoch;
}

export async function renewSpecialistExecutor(
  db: SqlTransaction,
  runId: string,
  placementId: string,
  ownerEpoch: number,
): Promise<void> {
  const [result] = (
    await db.execute(
      sql`SELECT renew_specialist_executor(${runId},${placementId},${ownerEpoch}) AS current`,
    )
  ).rows;

  if (result?.current !== true) throw lostExecutor(runId, placementId);
}

export async function assertSpecialistExecutor(
  db: SqlTransaction,
  runId: string,
  placementId: string,
  ownerEpoch: number,
): Promise<void> {
  const [result] = (
    await db.execute(
      sql`SELECT assert_specialist_executor(${runId},${placementId},${ownerEpoch}) AS current`,
    )
  ).rows;

  if (result?.current !== true) throw lostExecutor(runId, placementId);
}

/** The agent driver owns the heartbeat only for the lifetime of its current placement. */
export async function withSpecialistExecutor<T>(
  db: SqlTransaction,
  runId: string,
  placementId: string,
  work: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const ownerEpoch = await beginSpecialistExecutor(db, runId, placementId);

  const heartbeat = new AbortController();
  const authority = new AbortController();
  const driverSignal = signal
    ? AbortSignal.any([signal, authority.signal])
    : authority.signal;

  driverSignal.throwIfAborted();
  if (ownerEpoch === null) return work(driverSignal);
  const renewal = (async () => {
    while (!heartbeat.signal.aborted) {
      try {
        await delay(40_000, undefined, { signal: heartbeat.signal });
        if (driverSignal.aborted) return;
        await renewSpecialistExecutor(db, runId, placementId, ownerEpoch);
      } catch (error) {
        if (heartbeat.signal.aborted) return;
        log.warn(
          { runId, placementId, ...queryErrorDiagnostics(error) },
          "specialist executor renewal lost",
        );
        authority.abort(lostExecutor(runId, placementId));

        return;
      }
    }
  })();

  try {
    return await work(driverSignal);
  } finally {
    heartbeat.abort();
    await renewal;
  }
}
