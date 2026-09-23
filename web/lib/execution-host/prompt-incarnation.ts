import "server-only";

import type { Db } from "./db";
import type { BoundClient } from "./client";

import { and, eq } from "drizzle-orm";

import { runEventWakeBus } from "./events/run-wake";
import { RUNTIME_EVENT_CLAIM_LEASE_MS } from "./events/consumer";
import { projectionLimitsFromEnv } from "./events/projection-limits";
import {
  ADMISSIBLE_PROMPT_INCARNATION_STATES,
  staleSessionBinding,
} from "./session-binding";

import { runSessionIncarnations } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

/** The admission fence found no durable incarnation for the session yet. It is
 * a yield, never a run outcome: every caller leaves its run for the owner that
 * re-drives it (the flow and agent continuation workers, or the scratch user).
 */
export class PromptIncarnationPending extends MaisterError {
  constructor(input: {
    runId: string;
    assignmentId: string;
    hostSessionId: string;
  }) {
    super(
      "EXECUTOR_UNAVAILABLE",
      "session incarnation is not durable yet for prompt admission",
      { details: { reason: "prompt_incarnation_pending", ...input } },
    );
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The create ACK writes the exact incarnation as `created` in its own
 * transaction, so this normally returns on the first read. It waits only for
 * the window in which no ACK is durable yet; never guess the latest session.
 */
export async function waitForPromptIncarnation(
  db: Db,
  client: BoundClient,
  hostSessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  // After process death, stream takeover precedes lifecycle projection. A
  // deadline equal to the stream lease expires before takeover can finish.
  const deadline =
    performance.now() +
    RUNTIME_EVENT_CLAIM_LEASE_MS +
    projectionLimitsFromEnv().leaseMs;

  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    const [incarnation] = await db
      .select({ state: runSessionIncarnations.state })
      .from(runSessionIncarnations)
      .where(
        and(
          eq(runSessionIncarnations.executionHostId, client.host.id),
          eq(runSessionIncarnations.hostSessionId, hostSessionId),
          eq(
            runSessionIncarnations.executionAssignmentId,
            client.assignment.id,
          ),
        ),
      )
      .limit(1);

    signal?.throwIfAborted();
    if (
      incarnation &&
      (ADMISSIBLE_PROMPT_INCARNATION_STATES as readonly string[]).includes(
        incarnation.state,
      )
    )
      return;
    if (incarnation)
      throw staleSessionBinding(client.assignment.runId, client.assignment.id);
    await runEventWakeBus.wait(
      client.assignment.runId,
      Math.min(250, deadline - performance.now()),
      signal,
    );
  }
  throw new PromptIncarnationPending({
    runId: client.assignment.runId,
    assignmentId: client.assignment.id,
    hostSessionId,
  });
}
