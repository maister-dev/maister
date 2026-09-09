import "server-only";

import type { Db } from "./db";
import type { BoundClient } from "./client";

import { and, eq } from "drizzle-orm";

import { runEventWakeBus } from "./events/run-wake";
import { RUNTIME_EVENT_CLAIM_LEASE_MS } from "./events/consumer";
import { projectionLimitsFromEnv } from "./events/projection-limits";
import { staleSessionBinding } from "./session-binding";

import { runSessionIncarnations } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

/** The create ACK can precede lifecycle projection. Wait for its exact durable
 * incarnation before admitting a v2 prompt; never guess the latest session.
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
    if (incarnation?.state === "active") return;
    if (incarnation)
      throw staleSessionBinding(client.assignment.runId, client.assignment.id);
    await runEventWakeBus.wait(
      client.assignment.runId,
      Math.min(250, deadline - performance.now()),
      signal,
    );
  }
  throw new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    "session incarnation projection is not ready for prompt admission",
    {
      details: {
        reason: "prompt_incarnation_pending",
        runId: client.assignment.runId,
        assignmentId: client.assignment.id,
      },
    },
  );
}
