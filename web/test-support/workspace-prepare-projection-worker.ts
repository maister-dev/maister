import { closeDb, getDb } from "@/lib/db/client";
import { canonicalLifecycleProjector } from "@/lib/execution-host/events/lifecycle-projector";
import { projectExecutionEvents } from "@/lib/execution-host/events/projector";

async function main(): Promise<void> {
  const [runId, clock] = process.argv.slice(2);
  const now = new Date(clock);
  if (!runId || Number.isNaN(now.getTime()))
    throw new Error("A Run ID and projection clock are required");

  try {
    const summary = await projectExecutionEvents({
      db: getDb(),
      projector: canonicalLifecycleProjector,
      runId,
      now,
    });
    process.stdout.write(`workspace-projection ${JSON.stringify({ pid: process.pid, ...summary })}\n`);
  } finally {
    await closeDb();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
