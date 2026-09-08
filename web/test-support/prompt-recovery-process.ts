import { closeDb, getDb } from "@/lib/db/client";
import {
  queryPrompt,
  waitForPromptCompletion,
} from "@/lib/execution-host/deliverer";
import { defaultTransport } from "@/lib/execution-host/default-transport";
import { recoverExecutionCommands } from "@/lib/execution-host/recovery";
import {
  startRuntimeEventConsumer,
  stopRuntimeEventConsumers,
} from "@/lib/execution-host/events/consumer";
import {
  startCanonicalProjectionWorker,
  stopCanonicalProjectionWorker,
} from "@/lib/execution-host/events/projection-runtime";

async function main(): Promise<void> {
  const commandId = process.argv[2];
  const executionHostId = process.argv[3];

  if (!commandId || !executionHostId)
    throw new Error("command and host IDs are required");
  const db = getDb();
  const transport = defaultTransport();
  const handle = { commandId };
  const lookupReceipt = (id: string) => transport.getCommandReceipt(id);

  try {
    await recoverExecutionCommands({
      db,
      transport,
      graceMs: 0,
      now: () => new Date(Date.now() + 60_000),
    });
    startRuntimeEventConsumer({ db, transport, executionHostId });
    startCanonicalProjectionWorker();
    process.send?.(await queryPrompt({ db, handle, lookupReceipt }));
    const result = await waitForPromptCompletion({
      db,
      handle,
      lookupReceipt,
      signal: AbortSignal.timeout(60_000),
    });

    process.send?.({ commandId, state: "completed", result });
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
        error instanceof Error ? error.message : "unexpected recovery error",
    });
    process.exit(1);
  },
);
