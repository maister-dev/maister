import { closeDb, getDb } from "@/lib/db/client";
import { resumeRun } from "@/lib/runs/resume";

async function main(): Promise<void> {
  const runId = process.argv[2];

  if (!runId) throw new Error("run ID is required");
  const result = await resumeRun(runId, { db: getDb() });

  process.send?.({ state: "claimed", result });
  // The parent kills this process after the committed claim, before any
  // graph driver or session creation can be scheduled.
  await new Promise<void>(() => {});
}

void main().catch(async (error: unknown) => {
  process.send?.({
    state: "error",
    message: error instanceof Error ? error.message : String(error),
  });
  await closeDb();
  process.exit(1);
});
