import { eq } from "drizzle-orm";

import { closeDb, getDb } from "@/lib/db/client";
import { runSessions } from "@/lib/db/schema";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import {
  startCanonicalProjectionWorker,
  stopCanonicalProjectionWorker,
} from "@/lib/execution-host/events/projection-runtime";
import { sendScratchPromptAndProjectEvents } from "@/lib/scratch-runs/events";

// Drives ONE owned scratch dialog turn in its own process so a test can kill
// that process inside a specific write window. The accepted transcript row is
// created by the caller, exactly as the service creates it before dispatch.
async function main(): Promise<void> {
  const [runId, messageId, sequence, prompt] = process.argv.slice(2);

  if (!runId || !messageId || !sequence || !prompt)
    throw new Error("run ID, message ID, sequence and prompt are required");
  const db = getDb();

  startCanonicalProjectionWorker();
  try {
    const [session] = await db
      .select({ hostSessionId: runSessions.hostSessionId })
      .from(runSessions)
      .where(eq(runSessions.runId, runId));

    if (!session?.hostSessionId) throw new Error("no live scratch session");
    await sendScratchPromptAndProjectEvents({
      runId,
      sessionId: session.hostSessionId,
      stepId: "scratch",
      prompt,
      db,
      owner: {
        variant: "message",
        messageId,
        sequence: Number(sequence),
      },
    });
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
        error instanceof Error ? error.message : "unexpected scratch failure",
    });
    process.exit(1);
  },
);
