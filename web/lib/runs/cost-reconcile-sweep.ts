import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, asc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { costReconcileLookbackHours } from "@/lib/instance-config";
import { reconcileRunCostRollups } from "@/lib/runs/cost-rollups";

const { runs } = schema;

type Db = NodePgDatabase<typeof schema>;

// Mirrors the keepalive sweeper's per-tick ceiling + concurrency so the backstop
// stays bounded on a single host. SETTLE_GRACE forces one extra re-reconcile
// after ended_at so the supervisor's async final cost.jsonl flush is captured.
const PER_TICK_LIMIT = 50;
const RECONCILE_CONCURRENCY = 6;
const SETTLE_GRACE_MS = 2 * 60_000;

const log = pino({
  name: "cost-reconcile-sweep",
  level: process.env.LOG_LEVEL ?? "info",
});

export type CostReconcileSweepSummary = {
  candidates: number;
  reconciled: number;
};

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const slot = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor;

      cursor += 1;
      await worker(items[idx]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => slot()),
  );
}

// ADR-117 D8 — the completeness guarantee for run_cost_rollups. Keys on
// runs.ended_at (set on EVERY terminal transition), NOT a status allow-list and
// NOT a domain event, so it catches scratch-success runs (which emit no terminal
// event), historical backfill, and late cost-flush races. The
// `cost-rollup-reconcile` consumer is the separate low-latency fast-path; this
// sweep owns everything the consumer cannot.
//
// Progress is tracked by the durable runs.cost_reconciled_at marker (stamped on
// EVERY attempt — success, missing-cost, or error), NOT by run_cost_rollups row
// state. This is what makes the backstop actually complete + non-starving:
//   - a run with no cost.jsonl is attempted ONCE and then settled, instead of
//     staying eligible every tick and monopolizing the bounded oldest-first scan
//     ahead of newer runs;
//   - a pre-0083 rollup (NULL marker, empty by_runner) is re-reconciled once to
//     backfill its by_runner attribution.
// A run stays a candidate while cost_reconciled_at is NULL or still within
// ended_at + SETTLE_GRACE (the one extra re-reconcile that captures the
// supervisor's async final cost.jsonl flush).
export async function reconcileTerminalCostRollups(
  opts: {
    client?: Db;
    runtimeRoot?: string;
    lookbackHours?: number;
    limit?: number;
    settleGraceMs?: number;
    now?: Date;
    reconcile?: typeof reconcileRunCostRollups;
  } = {},
): Promise<CostReconcileSweepSummary> {
  const client = opts.client ?? (getDb() as unknown as Db);
  const reconcile = opts.reconcile ?? reconcileRunCostRollups;
  const now = opts.now ?? new Date();
  const lookbackHours = opts.lookbackHours ?? costReconcileLookbackHours();
  const limit = opts.limit ?? PER_TICK_LIMIT;
  const settleGraceMs = opts.settleGraceMs ?? SETTLE_GRACE_MS;
  const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60_000);
  const graceSeconds = settleGraceMs / 1000;

  const rows = await client
    .select({ runId: runs.id })
    .from(runs)
    .where(
      and(
        isNotNull(runs.endedAt),
        gt(runs.endedAt, cutoff),
        or(
          isNull(runs.costReconciledAt),
          sql`${runs.costReconciledAt} < ${runs.endedAt} + make_interval(secs => ${graceSeconds})`,
        ),
      ),
    )
    .orderBy(asc(runs.endedAt))
    .limit(limit);

  if (rows.length === 0) return { candidates: 0, reconciled: 0 };

  let reconciled = 0;

  await runWithConcurrency(rows, RECONCILE_CONCURRENCY, async (row) => {
    try {
      const result = await reconcile(row.runId, {
        client,
        runtimeRoot: opts.runtimeRoot,
      });

      if (result.status === "reconciled") reconciled += 1;
    } catch (err) {
      log.warn(
        {
          runId: row.runId,
          code: isMaisterError(err) ? err.code : "UNKNOWN",
          err: err instanceof Error ? err.message : String(err),
        },
        "cost-reconcile-sweep skipped run",
      );
    } finally {
      // Durable progress marker — stamped regardless of outcome so an
      // unreconcilable run (missing cost.jsonl / permanent CONFIG) is settled
      // after one attempt and never monopolizes the bounded scan. A stamp
      // before ended_at + grace still re-selects (late-flush capture); after it,
      // the run settles.
      await client
        .update(runs)
        .set({ costReconciledAt: now })
        .where(eq(runs.id, row.runId));
    }
  });

  log.debug(
    { candidates: rows.length, reconciled },
    "cost-reconcile-sweep completed",
  );

  return { candidates: rows.length, reconciled };
}
