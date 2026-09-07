import { once } from "node:events";

import { eq } from "drizzle-orm";

import { closeDb, getDb } from "@/lib/db/client";
import { hitlRequests, runs } from "@/lib/db/schema";
import { respondToHitl } from "@/lib/services/hitl";
import { startAgentContinuationWorker } from "@/lib/agents/continuation-worker";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import {
  startCanonicalProjectionWorker,
  stopCanonicalProjectionWorker,
} from "@/lib/execution-host/events/projection-runtime";

async function main(): Promise<void> {
  const hitlRequestId = process.argv[2];

  if (!hitlRequestId) throw new Error("pause HITL ID is required");
  const db = getDb();
  const shutdown = once(process, "message");
  const [row] = await db
    .select({ hitl: hitlRequests, run: runs })
    .from(hitlRequests)
    .innerJoin(runs, eq(runs.id, hitlRequests.runId))
    .where(eq(hitlRequests.id, hitlRequestId));

  if (!row?.run.projectId) throw new Error("pause fixture run is missing");
  startCanonicalProjectionWorker();
  const response = await respondToHitl(
    {
      runId: row.run.id,
      hitlRequestId,
      body:
        row.hitl.kind === "hook_trip"
          ? { optionId: "resume" }
          : { optionId: "raise", response: { newLimit: 10_000 } },
    },
    {
      kind: "user",
      userId: "agent-permission-user",
      label: "Agent pause recovery",
      preauthorizedProjectId: row.run.projectId,
    },
    { db },
  );

  if (response.status !== 202)
    throw new Error(`pause response returned ${response.status}`);
  const worker = startAgentContinuationWorker({ db });

  process.send?.({ state: "responded" });
  try {
    await shutdown;
  } finally {
    await worker.stop();
    await stopRuntimeEventConsumers();
    await stopCanonicalProjectionWorker();
    await closeDb();
  }
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.send?.({
      state: "error",
      message: error instanceof Error ? error.message : "pause fixture failed",
    });
    process.exit(1);
  },
);
