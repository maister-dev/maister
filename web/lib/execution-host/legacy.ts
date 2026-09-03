import type { Db } from "./db";

import { and, inArray, isNull } from "drizzle-orm";
import pino, { type Logger } from "pino";

import { LIVE_DRIVER_RUN_STATUSES } from "./hosts";

import { getDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";

// ADR-166 D9: pre-ADR-166 runs (`execution_assignment_id = NULL`) that a live
// driver status says are still executing. There is nothing to place them on:
// every host session created since the strict flip already belongs to a minted
// assignment, and the sessions that predate it died with the supervisor that
// owned them. `Running` rows are classified by the reconcile sweep (re-drive
// or Crashed); `NeedsInput` rows reach the keep-alive sweeper, whose
// checkpoint assigns them lazily (`ensureAssignment`, X-EH-18). This pass only
// makes them visible — once per run — at boot and on every sweep. MUST be
// deleted in Stage C together with `ensureAssignment`.

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "legacy-runs" });

export type LegacyRunsSummary = {
  candidates: number;
  runIds: string[];
};

export type LegacyRunsOptions = {
  db?: Db;
  logger?: Logger;
};

const state = { reported: new Set<string>() };

export function resetLegacyBackfillStateForTests(): void {
  state.reported.clear();
}

export async function reportLegacyActiveRuns(
  opts: LegacyRunsOptions = {},
): Promise<LegacyRunsSummary> {
  const db = opts.db ?? getDb();
  const logger = opts.logger ?? defaultLog;
  const candidates = await db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(
      and(
        isNull(runs.executionAssignmentId),
        inArray(runs.status, [...LIVE_DRIVER_RUN_STATUSES]),
      ),
    );
  const unreported = candidates.filter((c) => !state.reported.has(c.id));

  if (unreported.length > 0) {
    logger.warn(
      {
        candidates: unreported.map((c) => ({ runId: c.id, status: c.status })),
      },
      "legacy-runs-unplaced",
    );
    for (const c of unreported) state.reported.add(c.id);
  }

  return {
    candidates: candidates.length,
    runIds: candidates.map((c) => c.id),
  };
}
