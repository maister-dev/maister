import type { ScratchDialogStatus } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { MaisterError } from "@/lib/errors";
import { PromptIncarnationPending } from "@/lib/execution-host/prompt-incarnation";
import { markScratchPromptRetryable } from "@/lib/scratch-runs/service";
import { runStatusForDialogStatus } from "@/lib/scratch-runs/state";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// Adversarial-review F2: `markScratchPromptRetryable` (the initial-launch prompt
// failure handler) must only leave a run retryable when the prompt is still the
// active in-flight turn. `session_ready` is emitted BEFORE the prompt is posted,
// so a concurrent discard/stop/recover or a live supervisor event can move the
// run to a terminal / NeedsInput / WaitingForUser state while the prompt is in
// flight. A late EXECUTOR_UNAVAILABLE must NOT resurrect/clobber that newer state.

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test",
  });

  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
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

async function stateOf(runId: string): Promise<{
  dialogStatus: string;
  runStatus: string;
  errorCode: string | null;
}> {
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

const unavailable = new MaisterError(
  "EXECUTOR_UNAVAILABLE",
  "API key not valid",
);

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

// ADR-182 A4 (T1.4 RED A4): the admission yield returns the failed turn's row
// to the queue at its own `sequence`, so the continuation worker's scratch arm
// sends it again oldest-first. On master the row stayed `prompted` (or NULL
// for the launch prompt) and fell out of the queue.
describe("markScratchPromptRetryable — the failed turn's row goes back to the queue", () => {
  const yielded = (runId: string) =>
    new PromptIncarnationPending({
      runId,
      assignmentId: "assignment-1",
      hostSessionId: "host-session-1",
    });

  async function seedUserRow(
    runId: string,
    delivery: "prompted" | "steered" | "queued" | null,
    sequence = 1,
  ): Promise<string> {
    const id = randomUUID();

    await db.insert(schema.runMessages).values({
      id,
      runId,
      sequence,
      role: "user",
      content: `message ${sequence}`,
      delivery,
    });

    return id;
  }

  async function rowOf(id: string) {
    const [row] = await db
      .select({
        delivery: schema.runMessages.delivery,
        sequence: schema.runMessages.sequence,
      })
      .from(schema.runMessages)
      .where(eq(schema.runMessages.id, id));

    return row as { delivery: string | null; sequence: number };
  }

  it("a sent row flips prompted → queued at the same sequence", async () => {
    const { runId } = await seedScratchRun("Running");
    const messageId = await seedUserRow(runId, "prompted", 3);

    await expect(
      markScratchPromptRetryable({ db, runId, err: yielded(runId), messageId }),
    ).resolves.toEqual({ requeued: true });
    expect(await rowOf(messageId)).toEqual({ delivery: "queued", sequence: 3 });
    expect((await stateOf(runId)).dialogStatus).toBe("WaitingForUser");
  });

  it("the launch prompt's row flips NULL → queued", async () => {
    const { runId } = await seedScratchRun("Starting");
    const messageId = await seedUserRow(runId, null);

    await expect(
      markScratchPromptRetryable({ db, runId, err: yielded(runId), messageId }),
    ).resolves.toEqual({ requeued: true });
    expect((await rowOf(messageId)).delivery).toBe("queued");
  });

  it("an issued prompt's retryable failure keeps the row: its command owns the outcome", async () => {
    const { runId } = await seedScratchRun("Running");
    const messageId = await seedUserRow(runId, "prompted");

    // A re-send under the same logical key would re-attach to that command.
    await expect(
      markScratchPromptRetryable({ db, runId, err: unavailable, messageId }),
    ).resolves.toEqual({ requeued: false });
    expect((await rowOf(messageId)).delivery).toBe("prompted");
    expect((await stateOf(runId)).dialogStatus).toBe("WaitingForUser");
  });

  it("a steered row is not a turn of its own and is left alone", async () => {
    const { runId } = await seedScratchRun("Running");
    const messageId = await seedUserRow(runId, "steered");

    await expect(
      markScratchPromptRetryable({ db, runId, err: yielded(runId), messageId }),
    ).resolves.toEqual({ requeued: false });
    expect((await rowOf(messageId)).delivery).toBe("steered");
  });

  it("a dialog that already moved on keeps its row as it was (the fence)", async () => {
    const { runId } = await seedScratchRun("Crashed");
    const messageId = await seedUserRow(runId, "prompted");

    await expect(
      markScratchPromptRetryable({ db, runId, err: yielded(runId), messageId }),
    ).resolves.toEqual({ requeued: false });
    expect((await rowOf(messageId)).delivery).toBe("prompted");
  });

  it("a project-less assistant turn is not re-queued (its owner needs the edit-lock generation)", async () => {
    const { runId } = await seedScratchRun("Running");
    const lpId = randomUUID();

    await db.insert(schema.localPackages).values({
      id: lpId,
      name: "Assistant package",
      slug: `lp-${lpId.slice(0, 8)}`,
      workingDir: `/tmp/lp-${lpId.slice(0, 8)}`,
    });
    // The XOR CHECK needs the project cleared on both rows.
    await db
      .update(schema.scratchRuns)
      .set({ projectId: null, localPackageId: lpId })
      .where(eq(schema.scratchRuns.runId, runId));
    await db
      .update(schema.runs)
      .set({ projectId: null, localPackageId: lpId })
      .where(eq(schema.runs.id, runId));
    const messageId = await seedUserRow(runId, "prompted");

    await expect(
      markScratchPromptRetryable({ db, runId, err: yielded(runId), messageId }),
    ).resolves.toEqual({ requeued: false });
    expect((await rowOf(messageId)).delivery).toBe("prompted");
    expect((await stateOf(runId)).dialogStatus).toBe("WaitingForUser");
  });
});
