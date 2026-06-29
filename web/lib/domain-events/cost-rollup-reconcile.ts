import "server-only";

import type { DomainEventConsumer } from "@/lib/domain-events/consumers";
import type { DomainEventRow } from "@/lib/db/schema";

import pino from "pino";

import { getDb } from "@/lib/db/client";
import { isRunTerminalEventKind } from "@/lib/domain-events/taxonomy";
import { isMaisterError } from "@/lib/errors";
import { reconcileRunCostRollups } from "@/lib/runs/cost-rollups";

// FIXME(any): dual drizzle-orm peer-dep variants (matches ralph-loop.ts).
type Db = any;
type ReconcileFn = typeof reconcileRunCostRollups;

const log = pino({
  name: "cost-rollup-reconcile",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-117: the low-latency fast-path that reconciles run_cost_rollups seconds
// after a terminal that DOES emit. It is NOT the completeness guarantee — the
// system_sweep `ended_at` backstop covers scratch-success (which emits no
// terminal event) and historical backfill. `startFrom: "now"` (forward-only).
//
// D7 poison-safety: the dispatcher (`dispatch.ts`) BREAKS without advancing the
// cursor when a consumer's handle throws, so a single permanently-failing run
// would stall the whole cursor and block every later event (poison message).
// Therefore each per-run reconcile is wrapped in try/catch that logs WARN and
// continues — handle NEVER throws. A transient disk error is retried by the next
// sweep; a permanent one (CONFIG no-slug) is simply skipped.
//
// Idempotent via reconcileRunCostRollups (delete-then-insert + onConflictDoUpdate
// + sourceCursor), so at-least-once redelivery converges to one rollup.
export function buildCostRollupReconcileConsumer(
  opts: { db?: Db; runtimeRoot?: string; reconcile?: ReconcileFn } = {},
): DomainEventConsumer {
  return {
    id: "cost-rollup-reconcile",
    startFrom: "now",
    async handle(events: DomainEventRow[]): Promise<void> {
      const reconcile = opts.reconcile ?? reconcileRunCostRollups;
      const client = opts.db ?? getDb();
      const runIds = new Set<string>();

      for (const event of events) {
        if (!isRunTerminalEventKind(event.kind) || !event.runId) continue;

        runIds.add(event.runId);
      }

      for (const runId of runIds) {
        try {
          await reconcile(runId, { client, runtimeRoot: opts.runtimeRoot });
        } catch (err) {
          log.warn(
            {
              runId,
              code: isMaisterError(err) ? err.code : "UNKNOWN",
              err: err instanceof Error ? err.message : String(err),
            },
            "cost-rollup reconcile skipped run (poison-safe — never throws)",
          );
        }
      }
    },
  };
}

export const costRollupReconcileConsumer = buildCostRollupReconcileConsumer();
