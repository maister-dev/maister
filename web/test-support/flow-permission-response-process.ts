import { eq } from "drizzle-orm";

import { closeDb, getDb } from "@/lib/db/client";
import { hitlRequests, runs } from "@/lib/db/schema";
import { respondToHitl } from "@/lib/services/hitl";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";

async function main(): Promise<void> {
  const hitlRequestId = process.argv[2];
  const userId = process.argv[4];

  if (!hitlRequestId || !userId)
    throw new Error("HITL ID and user ID are required");
  const db = getDb();

  try {
    const [row] = await db
      .select({ hitl: hitlRequests, run: runs })
      .from(hitlRequests)
      .innerJoin(runs, eq(runs.id, hitlRequests.runId))
      .where(eq(hitlRequests.id, hitlRequestId));

    if (!row?.run.projectId)
      throw new Error("permission fixture run is missing");
    const response = await respondToHitl(
      { runId: row.run.id, hitlRequestId, body: { optionId: "allow" } },
      {
        kind: "user",
        userId,
        label: "Permission qualification",
        preauthorizedProjectId: row.run.projectId,
      },
      { db },
    );

    if (response.status !== 200)
      throw new Error(`permission response returned ${response.status}`);
  } finally {
    await stopRuntimeEventConsumers();
    await closeDb();
  }
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.send?.({
      state: "error",
      message:
        error instanceof Error ? error.message : "permission fixture failed",
    });
    process.exit(1);
  },
);
