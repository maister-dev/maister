import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  sendScratchPromptAndProjectEvents,
  type ScratchExecution,
} from "@/lib/scratch-runs/events";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { seedWorkspace } from "@/test-support/execution-host-seed";
// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches emit-run-status.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// =============================================================================
// T6 (fix-1) — live scratch terminal webhook emits.
//
// The LIVE scratch terminal path is `applyDialogStatus` in
// `@/lib/scratch-runs/events`, driven by the supervisor event consumer — it
// does NOT route through `markScratchCrashed` (reconcile-only) or the flow
// runner. `projectSupervisorEventToScratch` maps:
//   session.crashed              → dialogStatus "Crashed" → runs.status Crashed
//   session.exited(intentional)  → dialogStatus "Review"  → runs.status Review
//
// Pins the same DQ1 invariants proven for the state-transition helpers:
//   - a live scratch crash captures exactly one `run.crashed` outbox row
//     (data.errorCode is a string), committed atomically with the status flip.
//   - a live scratch intentional-exit captures exactly one `run.review` row
//     (data.source === "runner").
//   - every row: project_id + run_id == the run's, payload NULL, fanout_at NULL.
//
// (Scratch Done/Abandoned arrive via promote/drop and are wired there.)
// =============================================================================

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

async function seedScratchRun(): Promise<{
  projectId: string;
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
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
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
    status: "Running",
  });

  await db.insert(schema.scratchRuns).values({
    runId,
    projectId,
    createdByUserId: userId,
    initialPrompt: "do the thing",
    baseBranch: "main",
    baseCommit: "deadbeef",
    dialogStatus: "Running",
  });

  return { projectId, runId };
}

interface EventRow {
  id: string;
  type: string;
  project_id: string;
  run_id: string;
  data: Record<string, unknown>;
  payload: Record<string, unknown> | null;
  fanout_at: Date | null;
}

async function eventsForRun(runId: string): Promise<EventRow[]> {
  const result = await db.execute(sql`
    SELECT id, type, project_id, run_id, data, payload, fanout_at
    FROM webhook_events
    WHERE run_id = ${runId}
  `);

  return result.rows as unknown as EventRow[];
}

async function statusOf(runId: string): Promise<string> {
  const rows = await db
    .select({ status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return (rows[0] as { status: string }).status;
}

// The terminal follows real prompt admission and a projected incarnation.
// The transport is scripted; the command ledger and projections use Postgres.
async function terminalExecution(
  runId: string,
  projectId: string,
  terminal:
    | { type: "session.crashed" }
    | {
        type: "session.exited";
        reason: "intentional";
      },
): Promise<{ execution: ScratchExecution; sessionId: string }> {
  await seedWorkspace(db, {
    runId,
    projectId,
    worktreePath: `/tmp/scratch-emit/${runId}`,
    parentRepoPath: `/tmp/scratch-emit/${projectId}`,
  });
  const { hosts, fake } = await fakeExecutionHosts(db, { runId });
  const execution = await hosts.executionFor(runId);
  const session = await execution.client.createSession({
    stepId: "scratch",
    executor: { agent: "claude", model: "mock" },
  });

  fake.setPromptBehavior(async ({ sessionId }) => {
    fake.pushEvent(
      sessionId,
      terminal.type === "session.crashed"
        ? {
            type: "session.crashed" as const,
            sessionId,
            monotonicId: 1,
            exitCode: null,
            signal: "SIGKILL",
          }
        : {
            type: "session.exited" as const,
            sessionId,
            monotonicId: 1,
            exitCode: 0,
            reason: "intentional" as const,
          },
    );

    return { stopReason: "end_turn", meta: null };
  });

  return { execution, sessionId: session.hostSessionId };
}

describe("live scratch terminal → run.crashed", () => {
  it("winner: session.crashed captures exactly one run.crashed event (errorCode string)", async () => {
    const { projectId, runId } = await seedScratchRun();
    const { execution, sessionId } = await terminalExecution(runId, projectId, {
      type: "session.crashed",
    });

    await sendScratchPromptAndProjectEvents({
      runId,
      sessionId,
      stepId: "scratch",
      prompt: "go",
      owner: { variant: "initial" },
      db,
      execution,
    });

    expect(await statusOf(runId)).toBe("Crashed");

    const events = await eventsForRun(runId);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("run.crashed");
    expect(events[0].project_id).toBe(projectId);
    expect(events[0].run_id).toBe(runId);
    expect(events[0].payload).toBeNull();
    expect(events[0].fanout_at).toBeNull();
    expect(typeof (events[0].data as { errorCode: unknown }).errorCode).toBe(
      "string",
    );
  });
});

describe("live scratch terminal → run.review", () => {
  it("winner: session.exited(intentional) captures exactly one run.review event (source=runner)", async () => {
    const { projectId, runId } = await seedScratchRun();
    const { execution, sessionId } = await terminalExecution(runId, projectId, {
      type: "session.exited",
      reason: "intentional",
    });

    await sendScratchPromptAndProjectEvents({
      runId,
      sessionId,
      stepId: "scratch",
      prompt: "go",
      owner: { variant: "initial" },
      db,
      execution,
    });

    expect(await statusOf(runId)).toBe("Review");

    const events = await eventsForRun(runId);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("run.review");
    expect(events[0].project_id).toBe(projectId);
    expect(events[0].run_id).toBe(runId);
    expect(events[0].payload).toBeNull();
    expect(events[0].fanout_at).toBeNull();
    expect(events[0].data).toMatchObject({ source: "runner" });
  });
});
