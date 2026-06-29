import type { ScratchDialogStatus } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { MaisterError } from "@/lib/errors";
import { markScratchPromptRetryable } from "@/lib/scratch-runs/service";
import { runStatusForDialogStatus } from "@/lib/scratch-runs/state";

// Adversarial-review F2: `markScratchPromptRetryable` (the initial-launch prompt
// failure handler) must only leave a run retryable when the prompt is still the
// active in-flight turn. `session_ready` is emitted BEFORE the prompt is posted,
// so a concurrent discard/stop/recover or a live supervisor event can move the
// run to a terminal / NeedsInput / WaitingForUser state while the prompt is in
// flight. A late EXECUTOR_UNAVAILABLE must NOT resurrect/clobber that newer state.

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedScratchRun(dialogStatus: ScratchDialogStatus): Promise<{
  runId: string;
}> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const runId = randomUUID();
  const userId = randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    email: `u-${userId.slice(0, 8)}@test.local`,
  });
  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.runs).values({
    id: runId,
    runKind: "scratch",
    projectId,
    runnerId: executorId,
    capabilityAgent: "claude",
    flowVersion: "scratch",
    status: runStatusForDialogStatus(dialogStatus),
  });
  await db.insert(schema.scratchRuns).values({
    runId,
    projectId,
    createdByUserId: userId,
    initialPrompt: "do the thing",
    baseBranch: "main",
    baseCommit: "deadbeef",
    dialogStatus,
  });

  return { runId };
}

async function stateOf(
  runId: string,
): Promise<{ dialogStatus: string; runStatus: string; errorCode: string | null }> {
  const scratch = await db
    .select({
      dialogStatus: schema.scratchRuns.dialogStatus,
      errorCode: schema.scratchRuns.errorCode,
    })
    .from(schema.scratchRuns)
    .where(eq(schema.scratchRuns.runId, runId));
  const run = await db
    .select({ status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return {
    dialogStatus: (scratch[0] as { dialogStatus: string }).dialogStatus,
    runStatus: (run[0] as { status: string }).status,
    errorCode: (scratch[0] as { errorCode: string | null }).errorCode,
  };
}

const unavailable = new MaisterError("EXECUTOR_UNAVAILABLE", "API key not valid");

describe("markScratchPromptRetryable — in-flight prompt is left retryable", () => {
  it("Running → WaitingForUser + run Running + errorCode", async () => {
    const { runId } = await seedScratchRun("Running");

    await markScratchPromptRetryable({ db, runId, err: unavailable });

    const s = await stateOf(runId);

    expect(s.dialogStatus).toBe("WaitingForUser");
    expect(s.runStatus).toBe("Running");
    expect(s.errorCode).toBe("EXECUTOR_UNAVAILABLE");
  });

  it("Starting → WaitingForUser (also in-flight)", async () => {
    const { runId } = await seedScratchRun("Starting");

    await markScratchPromptRetryable({ db, runId, err: unavailable });

    expect((await stateOf(runId)).dialogStatus).toBe("WaitingForUser");
  });
});

describe("markScratchPromptRetryable — a late failure does NOT clobber a moved run (fence)", () => {
  // Each state models a run that a concurrent path moved while the initial
  // prompt was in flight; the late prompt failure must be a no-op.
  const moved: ScratchDialogStatus[] = [
    "Abandoned", // discard
    "Review", // supervisor stop with workspace / intentional exit
    "Crashed", // crash
    "Done", // promote
    "NeedsInput", // live permission request
    "WaitingForUser", // turn already completed
  ];

  it.each(moved)("already %s: preserved, not resurrected", async (status) => {
    const { runId } = await seedScratchRun(status);
    const before = await stateOf(runId);

    await markScratchPromptRetryable({ db, runId, err: unavailable });

    const after = await stateOf(runId);

    expect(after.dialogStatus).toBe(status);
    expect(after.runStatus).toBe(before.runStatus);
    // No errorCode stamped on a run we did not touch.
    expect(after.errorCode).toBeNull();
  });
});
