import { once } from "node:events";

import { closeDb, getDb } from "@/lib/db/client";
import {
  startAgentSession,
  sendAgentMessage,
  reworkChildRun,
} from "@/lib/agents/launch";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import {
  startCanonicalProjectionWorker,
  stopCanonicalProjectionWorker,
} from "@/lib/execution-host/events/projection-runtime";

async function main(): Promise<void> {
  const runId = process.argv[2];

  if (!runId) throw new Error("run ID is required");
  const db = getDb();
  const controller = new AbortController();
  const shutdown = once(process, "message").then(() => controller.abort());

  try {
    startCanonicalProjectionWorker();
    const message = process.argv[3];

    if (message === undefined)
      await startAgentSession(runId, { db, signal: controller.signal });
    else if (process.argv[5] === "rework")
      await reworkChildRun(runId, message, { db });
    else
      await sendAgentMessage(runId, message, {
        db,
        requestKey: process.argv[4],
        signal: controller.signal,
      });
    process.send?.({ state: "prompt_returned" });
    // The legacy stream consumer can still be applying after the prompt waiter
    // returns. Keep this real process alive until its parent finishes observing.
    await shutdown;
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
      message: error instanceof Error ? error.message : "agent launch failed",
    });
    process.exit(1);
  },
);
