import { getDb } from "@/lib/db/client";
import { runFlow } from "@/lib/flows/runner";
import {
  startCanonicalProjectionWorker,
  stopCanonicalProjectionWorker,
} from "@/lib/execution-host/events/projection-runtime";

// The consensus fan-out parks the parent immediately and dispatches its draft
// children on background microtasks, exactly as the long-lived web process
// does. This fixture therefore stays alive after runFlow returns so a test can
// kill it inside a specific draft write window.
async function main(): Promise<void> {
  const runId = process.argv[2];
  const runtimeRoot = process.argv[3];

  if (!runId || !runtimeRoot)
    throw new Error("run ID and runtime root are required");
  const db = getDb();

  startCanonicalProjectionWorker();
  try {
    await runFlow(runId, { db, runtimeRoot });
  } catch (error) {
    await stopCanonicalProjectionWorker();
    throw error;
  }
  await new Promise<never>(() => {});
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
