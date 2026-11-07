import "server-only";

import type { SupervisorSessionRecord } from "@/lib/execution-host";

import pino from "pino";

import {
  createExecutionHosts,
  type ExecutionHosts,
} from "@/lib/execution-host";

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
 *
 * Each run requires an attested scoped inventory; aggregate observations can
 * contribute positive session identities but never prove process absence.
 */
export async function teardownLiveSessionsForRuns(
  runIds: readonly string[],
  opts: {
    records?: readonly SupervisorSessionRecord[];
    logLabel: string;
    executionHosts?: ExecutionHosts;
  },
): Promise<void> {
  if (runIds.length === 0) return;

  const hosts = opts.executionHosts ?? createExecutionHosts();

  for (const runId of runIds) {
    let records: readonly SupervisorSessionRecord[];

    try {
      records = [
        ...(await hosts.local().listSessionsForRun(runId)),
        ...(opts.records ?? []).filter(
          (record) => record.runId === runId && record.status === "live",
        ),
      ];
    } catch (error) {
      log.warn(
        {
          runId,
          errorType: error instanceof Error ? error.name : typeof error,
          logLabel: opts.logLabel,
        },
        "process inventory unproven; retaining pending session teardown",
      );
      continue;
    }
    const live = records.filter(
      (r) => r.status === "live" && r.runId === runId,
    );

    if (live.length === 0) continue;

    let client: Awaited<ReturnType<ExecutionHosts["forRun"]>>;

    try {
      client = await hosts.forRun(runId, { teardown: true });
    } catch (err) {
      log.warn(
        { runId, err: err instanceof Error ? err.message : String(err) },
        `${opts.logLabel} host binding failed — leaving teardown to the reconcile sweep`,
      );
      continue;
    }

    for (const session of live) {
      await client.deleteSession(session.sessionId).catch((err: unknown) => {
        log.warn(
          {
            runId,
            sessionId: session.sessionId,
            err: err instanceof Error ? err.message : String(err),
          },
          `${opts.logLabel} child session teardown failed — continuing`,
        );
      });
    }
  }
}
