import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { FlowDriverClaim } from "./driver-claim";

import { setTimeout as delay } from "node:timers/promises";

import pino from "pino";

import { renewFlowDriverClaim, releaseFlowDriverClaim } from "./driver-claim";

const log = pino({
  name: "flow-driver",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Renewal is independent of the graph's external waits. Shutdown drains the
 * renewal before releasing only this token; a failed renewal cancels all later
 * traversal transactions and owner admission, leaving durable work recoverable.
 */
export async function withFlowDriver<T>(
  db: Db,
  claim: FlowDriverClaim,
  work: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const lifetime = new AbortController();
  const renewal = new AbortController();
  const traversalSignal = signal
    ? AbortSignal.any([signal, lifetime.signal])
    : lifetime.signal;
  const renew = (async () => {
    while (!renewal.signal.aborted && !traversalSignal.aborted) {
      try {
        await delay(10_000, undefined, { signal: renewal.signal });
      } catch (error) {
        if (renewal.signal.aborted) return;
        throw error;
      }
      if (traversalSignal.aborted) return;
      try {
        await renewFlowDriverClaim(db, claim);
      } catch (error) {
        log.warn(
          { runId: claim.runId, assignmentId: claim.assignmentId },
          "flow-driver-renewal-lost",
        );
        lifetime.abort(error);

        return;
      }
    }
  })();

  log.info(
    { runId: claim.runId, assignmentId: claim.assignmentId },
    "flow-driver-acquired",
  );
  try {
    return await work(traversalSignal);
  } finally {
    renewal.abort();
    await renew;
    await releaseFlowDriverClaim(db, claim);
    log.info(
      { runId: claim.runId, assignmentId: claim.assignmentId },
      "flow-driver-released",
    );
  }
}
