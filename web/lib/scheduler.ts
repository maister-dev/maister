import "server-only";

import { and, asc, count, eq, inArray, lt, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "scheduler",
  level: process.env.LOG_LEVEL ?? "info",
});

const DEFAULT_CAP = 3;

function capFromEnv(): number {
  const raw = process.env.MAISTER_MAX_CONCURRENT_RUNS;

  if (!raw) return DEFAULT_CAP;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CAP;

  return parsed;
}

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type TryStartRunResult =
  | { started: true }
  | { started: false; queuePosition: number };

export async function tryStartRun(
  runId: string,
  opts: { db?: Db } = {},
): Promise<TryStartRunResult> {
  const db = opts.db ?? getDb();
  const cap = capFromEnv();

  return db.transaction(async (tx: Db) => {
    const liveRows: Array<{ count: number }> = await tx
      .select({ count: count() })
      .from(runs)
      .where(inArray(runs.status, ["Running", "NeedsInput"]));

    const liveCount = Number(liveRows[0]?.count ?? 0);

    log.debug({ runId, liveCount, cap }, "tryStartRun cap-check");

    if (liveCount < cap) {
      await tx
        .update(runs)
        .set({ status: "Running", startedAt: new Date() })
        .where(and(eq(runs.id, runId), eq(runs.status, "Pending")));

      log.info({ runId, liveCount, cap }, "tryStartRun → started");

      return { started: true } satisfies TryStartRunResult;
    }

    const targetRows: Array<{ startedAt: Date }> = await tx
      .select({ startedAt: runs.startedAt })
      .from(runs)
      .where(eq(runs.id, runId));

    const targetStartedAt = targetRows[0]?.startedAt ?? new Date();

    const aheadRows: Array<{ count: number }> = await tx
      .select({ count: count() })
      .from(runs)
      .where(
        and(eq(runs.status, "Pending"), lt(runs.startedAt, targetStartedAt)),
      );

    const queuePosition = Number(aheadRows[0]?.count ?? 0) + 1;

    log.info(
      { runId, liveCount, cap, queuePosition },
      "tryStartRun → queued",
    );

    return { started: false, queuePosition } satisfies TryStartRunResult;
  });
}

export type PromoteNextPendingOptions = {
  db?: Db;
  runFlow?: (runId: string) => void;
};

export async function promoteNextPending(
  opts: PromoteNextPendingOptions = {},
): Promise<{ promotedRunId: string | null }> {
  const db = opts.db ?? getDb();

  const promotedRunId = await db.transaction(async (tx: Db) => {
    const oldest: Array<{ id: string }> = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.status, "Pending"))
      .orderBy(asc(runs.startedAt))
      .limit(1)
      .for("update", { skipLocked: true } as never);

    const targetId = oldest[0]?.id;

    if (!targetId) return null;

    await tx
      .update(runs)
      .set({ status: "Running", startedAt: new Date() })
      .where(and(eq(runs.id, targetId), eq(runs.status, "Pending")));

    return targetId;
  });

  if (promotedRunId && opts.runFlow) {
    log.info({ promotedRunId }, "promoteNextPending → promoting");
    queueMicrotask(() => {
      try {
        opts.runFlow?.(promotedRunId);
      } catch (err) {
        log.error(
          { err: (err as Error).message, promotedRunId },
          "promoteNextPending runFlow dispatch failed",
        );
      }
    });
  } else if (!promotedRunId) {
    log.debug({}, "promoteNextPending → nothing to promote");
  }

  return { promotedRunId: promotedRunId ?? null };
}

// Helper exported so tests can compute cap without env mocking.
export function _maxConcurrentRunsFromEnv(): number {
  return capFromEnv();
}

// Reserved drizzle sql helper kept exported so the runner can build
// custom queries without a second import line. Currently unused
// externally — keep for follow-up M5+ work where the scheduler grows
// the cap into a per-project policy.
export const _sqlBuilder = sql;
