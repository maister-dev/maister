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
 * reconcile sweep reaps a live session under an `Abandoned` row on its next
 * tick. Matched by runId and never narrowed by stepId — a run may hold more
 * than one logical session, so EVERY live one is stopped.
 */
export async function teardownLiveSessionsForRuns(
  runIds: readonly string[],
  opts: { records?: readonly SupervisorSessionRecord[]; logLabel: string },
): Promise<void> {
  if (runIds.length === 0) return;

  let records: readonly SupervisorSessionRecord[];

  try {
    records = opts.records ?? (await listSessions());
  } catch (err) {
    log.warn(
      { runIds, err: err instanceof Error ? err.message : String(err) },
      `${opts.logLabel} listSessions failed — leaving teardown to the reconcile sweep`,
    );

    return;
  }

  for (const runId of runIds) {
    for (const live of records.filter(
      (r) => r.status === "live" && r.runId === runId,
    )) {
      await deleteSession(live.sessionId).catch((err: unknown) => {
        log.warn(
          {
            runId,
            sessionId: live.sessionId,
            err: err instanceof Error ? err.message : String(err),
          },
          `${opts.logLabel} child session teardown failed — continuing`,
        );
      });
    }
  }
}
