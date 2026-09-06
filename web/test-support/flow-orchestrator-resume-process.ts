import { eq } from "drizzle-orm";

import { closeDb, getDb } from "@/lib/db/client";
import { domainEvents } from "@/lib/db/schema";
import { buildOrchestratorResumeConsumer } from "@/lib/domain-events/orchestrator-resume";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import {
  startCanonicalProjectionWorker,
  stopCanonicalProjectionWorker,
} from "@/lib/execution-host/events/projection-runtime";
import { runFlow } from "@/lib/flows/runner";

async function main(): Promise<void> {
  const eventId = Number(process.argv[2]);
  const runtimeRoot = process.argv[3];

  if (!Number.isSafeInteger(eventId) || !runtimeRoot)
    throw new Error("event ID and runtime root are required");
  const db = getDb();

  try {
    startCanonicalProjectionWorker();
    const events = await db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.id, eventId));

    if (events.length !== 1)
      throw new Error("child completion event is missing");
    await buildOrchestratorResumeConsumer({
      db,
      resumeFlow: (runId, options) =>
        runFlow(runId, { ...options, runtimeRoot }),
    }).handle(events);
  } finally {
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
      message:
        error instanceof Error ? error.message : "unexpected resume failure",
    });
    process.exit(1);
  },
);
