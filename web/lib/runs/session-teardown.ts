import "server-only";

import pino from "pino";

import {
  deleteSession,
  listSessions,
  type SupervisorSessionRecord,
} from "@/lib/supervisor-client";

const log = pino({
  name: "session-teardown",
  level: process.env.LOG_LEVEL ?? "info",
});

/**
 * Best-effort teardown of the live ACP sessions of runs that were just flipped
 * terminal in the database. `cascadeAbandonRunTree` flips rows only ("sessions
 * live in the supervisor"), and the graph runner does not notice an external
 * `Abandoned`, so without this the children keep spending to completion under a
 * terminal tree. Errors are tolerated: the row is already terminal and the
 * supervisor-side reconcile reaps any orphan. Matched by runId — a running child
 * has one live session; never narrowed by stepId.
 */
export async function teardownLiveSessionsForRuns(
  runIds: readonly string[],
  opts: { records?: SupervisorSessionRecord[]; logLabel: string },
): Promise<void> {
  if (runIds.length === 0) return;

  const records = opts.records ?? (await listSessions());

  for (const runId of runIds) {
    const live = records.find((r) => r.status === "live" && r.runId === runId);

    if (!live) continue;

    await deleteSession(live.sessionId).catch((err: unknown) => {
      log.warn(
        { runId, err: err instanceof Error ? err.message : String(err) },
        `${opts.logLabel} child session teardown failed — continuing`,
      );
    });
  }
}
