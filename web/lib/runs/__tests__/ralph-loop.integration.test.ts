import type { DomainEventRow } from "@/lib/db/schema";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";
import type { LaunchRunInput } from "@/lib/services/runs";

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { buildRalphLoopConsumer } from "@/lib/runs/ralph-loop";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let runnerId: string;
let flowId: string;

// Fixed base so seeded started_at ordering (the "latest run" key) is
// deterministic; relaunched/newer runs get strictly later stamps.
const BASE = new Date("2026-01-01T00:00:00.000Z");

const ralphPolicy: ExecutionPolicy = {
  preset: "supervised",
  overrides: { crashRetry: "ralph_loop" },
};

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

beforeEach(async () => {
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "tasks"`);
  await pool.query(`DELETE FROM "flows"`);
  await pool.query(`DELETE FROM "platform_acp_runners"`);
  await pool.query(`DELETE FROM "projects"`);

  projectId = randomUUID();
  runnerId = randomUUID();
  flowId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `p-${projectId.slice(0, 8)}`,
    name: "P",
    repoPath: `/repos/${projectId}`,
    maisterYamlPath: "/tmp/m.yaml",
    taskKey: `T${projectId
      .replace(/[^0-9A-Za-z]/g, "")
      .slice(0, 7)
      .toUpperCase()}`,
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "g",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g",
    manifest: {},
    schemaVersion: 1,
  });
});

async function seedTask(args: {
  attemptNumber?: number;
  status?: "Backlog" | "InFlight" | "Done" | "Abandoned";
}): Promise<string> {
  const taskId = randomUUID();

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: Math.trunc(Math.random() * 1e9) + 1,
    title: "t",
    prompt: "p",
    flowId,
    status: args.status ?? "InFlight",
    attemptNumber: args.attemptNumber ?? 1,
  });

  return taskId;
}

async function insertRun(args: {
  taskId: string;
  status: string;
  startedAt: Date;
  executionPolicy?: ExecutionPolicy;
  runKind?: "flow" | "scratch" | "agent";
}): Promise<string> {
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    taskId: args.taskId,
    projectId,
    flowId,
    runnerId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(runnerId),
    flowVersion: "v1.0.0",
    status: args.status,
    runKind: args.runKind ?? "flow",
    executionPolicy: args.executionPolicy ?? ralphPolicy,
    startedAt: args.startedAt,
  });

  return runId;
}

function runFailedEvent(runId: string): DomainEventRow {
  return {
    id: 1 as unknown as DomainEventRow["id"],
    kind: "run.failed",
    projectId,
    taskId: null,
    runId,
    actorType: "system",
    actorId: null,
    payload: {},
    occurredAt: new Date(),
    createdAt: new Date(),
    txId: "0" as unknown as DomainEventRow["txId"],
  } as DomainEventRow;
}

// A launch mock that records its calls AND reproduces launchRun's observable
// side effects: a fresh Pending flow run with a strictly-later started_at (so
// it becomes the task's latest run) + the tasks.attempt_number bump. This lets
// the at-least-once redelivery test exercise the real latest-run idempotency.
function recordingLaunch() {
  const calls: LaunchRunInput[] = [];
  let n = 0;
  const launch = async (input: LaunchRunInput) => {
    calls.push(input);
    n += 1;
    const newRunId = await insertRun({
      taskId: input.taskId,
      status: "Pending",
      startedAt: new Date(BASE.getTime() + n * 60_000),
    });

    await db
      .update(schema.tasks)
      .set({ attemptNumber: sql`${schema.tasks.attemptNumber} + 1` })
      .where(eq(schema.tasks.id, input.taskId));

    return { runId: newRunId, status: "Pending" };
  };

  return { calls, launch };
}

describe("ralph-loop consumer (execution-policy axis A2)", () => {
  it("ralph_loop under the cap → auto-relaunches once with the same task + policy", async () => {
    const taskId = await seedTask({ attemptNumber: 2 });
    const runId = await insertRun({
      taskId,
      status: "Failed",
      startedAt: BASE,
    });
    const { calls, launch } = recordingLaunch();

    await buildRalphLoopConsumer({ db, launch, maxAttempts: () => 5 }).handle([
      runFailedEvent(runId),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].taskId).toBe(taskId);
    expect(
      (calls[0].executionPolicy as ExecutionPolicy).overrides?.crashRetry,
    ).toBe("ralph_loop");
  });

  it("at-least-once redelivery converges to exactly one relaunch (idempotent)", async () => {
    const taskId = await seedTask({ attemptNumber: 2 });
    const runId = await insertRun({
      taskId,
      status: "Failed",
      startedAt: BASE,
    });
    const { calls, launch } = recordingLaunch();
    const consumer = buildRalphLoopConsumer({
      db,
      launch,
      maxAttempts: () => 5,
    });
    const event = runFailedEvent(runId);

    // Same window delivered twice (crash-before-cursor-advance redelivery).
    await consumer.handle([event]);
    await consumer.handle([event]);

    expect(calls).toHaveLength(1);
  });

  it("non-ralph policy (supervised → crashRetry=fail) → no relaunch", async () => {
    const taskId = await seedTask({ attemptNumber: 1 });
    const runId = await insertRun({
      taskId,
      status: "Failed",
      startedAt: BASE,
      executionPolicy: { preset: "supervised" },
    });
    const { calls, launch } = recordingLaunch();

    await buildRalphLoopConsumer({ db, launch, maxAttempts: () => 5 }).handle([
      runFailedEvent(runId),
    ]);

    expect(calls).toHaveLength(0);
  });

  it("at the cap (attempt_number === max) → holds in Backlog, no relaunch", async () => {
    const taskId = await seedTask({ attemptNumber: 5 });
    const runId = await insertRun({
      taskId,
      status: "Failed",
      startedAt: BASE,
    });
    const { calls, launch } = recordingLaunch();

    await buildRalphLoopConsumer({ db, launch, maxAttempts: () => 5 }).handle([
      runFailedEvent(runId),
    ]);

    expect(calls).toHaveLength(0);
  });

  it("stale failure (a newer attempt already exists) → no relaunch", async () => {
    const taskId = await seedTask({ attemptNumber: 3 });
    // The failed run is older; a newer flow run is already the task's latest.
    const staleRunId = await insertRun({
      taskId,
      status: "Failed",
      startedAt: BASE,
    });

    await insertRun({
      taskId,
      status: "Running",
      startedAt: new Date(BASE.getTime() + 60_000),
    });
    const { calls, launch } = recordingLaunch();

    await buildRalphLoopConsumer({ db, launch, maxAttempts: () => 5 }).handle([
      runFailedEvent(staleRunId),
    ]);

    expect(calls).toHaveLength(0);
  });

  it("a terminally Abandoned task never relaunches", async () => {
    const taskId = await seedTask({ attemptNumber: 2, status: "Abandoned" });
    const runId = await insertRun({
      taskId,
      status: "Failed",
      startedAt: BASE,
    });
    const { calls, launch } = recordingLaunch();

    await buildRalphLoopConsumer({ db, launch, maxAttempts: () => 5 }).handle([
      runFailedEvent(runId),
    ]);

    expect(calls).toHaveLength(0);
  });

  it("non-flow runs (scratch/agent) never ralph", async () => {
    const taskId = await seedTask({ attemptNumber: 1 });
    const runId = await insertRun({
      taskId,
      status: "Failed",
      startedAt: BASE,
      runKind: "agent",
    });
    const { calls, launch } = recordingLaunch();

    await buildRalphLoopConsumer({ db, launch, maxAttempts: () => 5 }).handle([
      runFailedEvent(runId),
    ]);

    expect(calls).toHaveLength(0);
  });

  it("a launch refusal is swallowed (idempotent contract — handle never throws)", async () => {
    const taskId = await seedTask({ attemptNumber: 1 });
    const runId = await insertRun({
      taskId,
      status: "Failed",
      startedAt: BASE,
    });
    const throwingLaunch = async () => {
      throw new Error("cap full / dirty repo / etc");
    };

    await expect(
      buildRalphLoopConsumer({
        db,
        launch: throwingLaunch,
        maxAttempts: () => 5,
      }).handle([runFailedEvent(runId)]),
    ).resolves.toBeUndefined();
  });

  it("ignores non-run.failed events", async () => {
    const taskId = await seedTask({ attemptNumber: 1 });
    const runId = await insertRun({
      taskId,
      status: "Failed",
      startedAt: BASE,
    });
    const { calls, launch } = recordingLaunch();

    await buildRalphLoopConsumer({ db, launch, maxAttempts: () => 5 }).handle([
      { ...runFailedEvent(runId), kind: "run.crashed" } as DomainEventRow,
    ]);

    expect(calls).toHaveLength(0);
  });
});
