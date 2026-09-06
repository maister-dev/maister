import { closeDb, getDb } from "@/lib/db/client";
import { runFlow } from "@/lib/flows/runner";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import {
  startCanonicalProjectionWorker,
  stopCanonicalProjectionWorker,
} from "@/lib/execution-host/events/projection-runtime";

async function main(): Promise<void> {
  const runId = process.argv[2];
  const runtimeRoot = process.argv[3];

  if (!runId || !runtimeRoot)
    throw new Error("run ID and runtime root are required");
  const db = getDb();

  try {
    startCanonicalProjectionWorker();
    await runFlow(runId, { db, runtimeRoot });
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
        error instanceof Error ? error.message : "unexpected Flow failure",
    });
    process.exit(1);
  },
);
