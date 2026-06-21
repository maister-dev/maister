// Phase 1 of cost-budget governance — the token / failure / wall-clock
// aggregation foundation the breach watchdog reads. These pure query helpers
// sum the four BASE token columns of run_cost_rollups at run / task / tree
// scope, count trailing failure streaks over node_attempts (per-attempt) and
// runs (per-task / per-tree), and compute tree wall-clock from the root run's
// started_at. No watchdog / HITL / UI here — just the read substrate.
//
// Harness mirrors time-limit-watchdog.integration.test.ts: testcontainers
// postgres:16-alpine, drizzle migrate against ./lib/db/migrations, rows seeded
// directly. run_cost_rollups rows are inserted by hand (the query helpers read
// rollup rows; they do not parse cost.jsonl, so no on-disk fixture is needed).

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import {
  consecutiveFailedAttempts,
  consecutiveFailedRuns,
  treeWallClockMinutes,
} from "@/lib/runs/budget-meters";
import {
  queryRunTokens,
  queryRunTreeTokens,
  queryTaskTokens,
} from "@/lib/runs/cost-rollups";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;

const opts = (): { client: NodePgDatabase<any> } => ({
  client: db as NodePgDatabase<any>,
});

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("budget_agg_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    slug: "budget-app",
    name: "Budget App",
    repoPath: "/repos/budget-app",
    maisterYamlPath: "/repos/budget-app/maister.yaml",
  });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(schema.nodeAttemptCostRollups);
  await db.delete(schema.runCostRollups);
  await db.delete(schema.nodeAttempts);
  await db.delete(schema.runs);
  await db.delete(schema.tasks);
});

async function seedTask(): Promise<string> {
  const taskId = randomUUID();

  await db.insert(schema.tasks).values({
    id: taskId,
    number: Math.trunc(Math.random() * 1e9) + 1,
    projectId,
    title: "t",
    prompt: "p",
    status: "InFlight",
  });

  return taskId;
}

// A minimal run row. Token sums never touch run columns (they read rollups), so
// status/started_at only matter for the failure/wall-clock meters.
async function seedRun(opts: {
  taskId?: string | null;
  rootRunId?: string | null;
  status?: string;
  startedAt?: Date;
  runKind?: string;
}): Promise<string> {
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    taskId: opts.taskId ?? null,
    projectId,
    rootRunId: opts.rootRunId ?? null,
    status: opts.status ?? "Running",
    runKind: opts.runKind ?? "flow",
    flowVersion: "v1.0.0",
    startedAt: opts.startedAt ?? new Date(),
  });

  return runId;
}

// Insert a run_cost_rollups row carrying the four BASE token columns. The four
// resume* columns are a subset already folded into the base by addRecord, so a
// budget total is the sum of the four base columns only — set resume* low to
// prove they are NOT double-counted.
async function seedRollup(
  runId: string,
  taskId: string | null,
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  },
): Promise<void> {
  await db.insert(schema.runCostRollups).values({
    runId,
    projectId,
    taskId,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cacheRead,
    cacheCreationTokens: tokens.cacheCreation,
    resumeInputTokens: 1,
    resumeOutputTokens: 1,
    resumeCacheReadTokens: 1,
    resumeCacheCreationTokens: 1,
    sourceEventCount: 1,
  });
}

async function seedAttempt(opts: {
  runId: string;
  nodeId?: string;
  attempt: number;
  status: string;
  startedAt?: Date;
}): Promise<void> {
  await db.insert(schema.nodeAttempts).values({
    id: randomUUID(),
    runId: opts.runId,
    nodeId: opts.nodeId ?? "implement",
    nodeType: "ai_coding",
    attempt: opts.attempt,
    status: opts.status,
    startedAt: opts.startedAt ?? new Date(),
  });
}

describe("budget aggregation — token sums", () => {
  it("queryRunTokens sums the four base columns for the run's rollup row", async () => {
    const taskId = await seedTask();
    const runId = await seedRun({ taskId });

    await seedRollup(runId, taskId, {
      input: 100,
      output: 200,
      cacheRead: 300,
      cacheCreation: 400,
    });

    expect(await queryRunTokens(runId, opts())).toBe(1000);
  });

  it("queryRunTokens returns 0 when no rollup row exists", async () => {
    const runId = await seedRun({});

    expect(await queryRunTokens(runId, opts())).toBe(0);
  });

  it("queryTaskTokens sums rollups across all runs of one task", async () => {
    const taskId = await seedTask();
    const runA = await seedRun({ taskId });
    const runB = await seedRun({ taskId });
    // A run of a DIFFERENT task must not leak into the sum.
    const otherTaskId = await seedTask();
    const runOther = await seedRun({ taskId: otherTaskId });

    await seedRollup(runA, taskId, {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheCreation: 40,
    });
    await seedRollup(runB, taskId, {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheCreation: 4,
    });
    await seedRollup(runOther, otherTaskId, {
      input: 5000,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    });

    // (10+20+30+40) + (1+2+3+4) = 100 + 10 = 110.
    expect(await queryTaskTokens(taskId, opts())).toBe(110);
  });

  it("queryTaskTokens returns 0 for a task with no rollups", async () => {
    const taskId = await seedTask();

    expect(await queryTaskTokens(taskId, opts())).toBe(0);
  });

  it("queryRunTreeTokens sums rollups across child runs sharing root_run_id", async () => {
    const rootRunId = randomUUID();

    // The root run itself is part of its own tree (root_run_id === own id).
    await db.insert(schema.runs).values({
      id: rootRunId,
      projectId,
      rootRunId,
      status: "WaitingOnChildren",
      runKind: "flow",
      flowVersion: "v1.0.0",
      startedAt: new Date(),
    });
    const childA = await seedRun({ rootRunId });
    const childB = await seedRun({ rootRunId });
    // A run under a different tree must not leak in.
    const otherRoot = randomUUID();

    await db.insert(schema.runs).values({
      id: otherRoot,
      projectId,
      rootRunId: otherRoot,
      status: "Running",
      runKind: "flow",
      flowVersion: "v1.0.0",
      startedAt: new Date(),
    });

    await seedRollup(rootRunId, null, {
      input: 1,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    });
    await seedRollup(childA, null, {
      input: 10,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    });
    await seedRollup(childB, null, {
      input: 100,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    });
    await seedRollup(otherRoot, null, {
      input: 9999,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    });

    expect(await queryRunTreeTokens(rootRunId, opts())).toBe(111);
  });

  it("queryRunTreeTokens returns 0 for an empty tree", async () => {
    expect(await queryRunTreeTokens(randomUUID(), opts())).toBe(0);
  });
});

describe("budget aggregation — failure streaks", () => {
  it("consecutiveFailedAttempts counts the trailing Failed streak and stops at a Succeeded", async () => {
    const runId = await seedRun({});

    // attempt order (DESC): 4=Failed, 3=Failed, 2=Succeeded, 1=Failed.
    // The trailing streak is 2 (attempts 4 and 3); attempt 2 stops it.
    await seedAttempt({ runId, attempt: 1, status: "Failed" });
    await seedAttempt({ runId, attempt: 2, status: "Succeeded" });
    await seedAttempt({ runId, attempt: 3, status: "Failed" });
    await seedAttempt({ runId, attempt: 4, status: "Failed" });

    expect(await consecutiveFailedAttempts(runId, opts())).toBe(2);
  });

  it("consecutiveFailedAttempts is 0 when the most recent attempt is not Failed", async () => {
    const runId = await seedRun({});

    await seedAttempt({ runId, attempt: 1, status: "Failed" });
    await seedAttempt({ runId, attempt: 2, status: "Running" });

    expect(await consecutiveFailedAttempts(runId, opts())).toBe(0);
  });

  it("consecutiveFailedAttempts is 0 with no attempts", async () => {
    const runId = await seedRun({});

    expect(await consecutiveFailedAttempts(runId, opts())).toBe(0);
  });

  it("consecutiveFailedRuns counts the trailing Failed/Crashed/Abandoned streak by task", async () => {
    const taskId = await seedTask();
    const base = Date.now();

    // started_at order (DESC): newest=Crashed, Abandoned, Failed, then Done.
    // Trailing failure streak = 3; the Done run stops it.
    await seedRun({
      taskId,
      status: "Done",
      startedAt: new Date(base - 4000),
    });
    await seedRun({
      taskId,
      status: "Failed",
      startedAt: new Date(base - 3000),
    });
    await seedRun({
      taskId,
      status: "Abandoned",
      startedAt: new Date(base - 2000),
    });
    await seedRun({
      taskId,
      status: "Crashed",
      startedAt: new Date(base - 1000),
    });

    expect(await consecutiveFailedRuns({ taskId }, opts())).toBe(3);
  });

  it("consecutiveFailedRuns is 0 when the latest run by started_at is not a failure", async () => {
    const taskId = await seedTask();
    const base = Date.now();

    await seedRun({
      taskId,
      status: "Failed",
      startedAt: new Date(base - 2000),
    });
    await seedRun({
      taskId,
      status: "Running",
      startedAt: new Date(base - 1000),
    });

    expect(await consecutiveFailedRuns({ taskId }, opts())).toBe(0);
  });

  it("consecutiveFailedRuns counts the trailing failure streak by tree (root_run_id)", async () => {
    const rootRunId = randomUUID();
    const base = Date.now();

    await db.insert(schema.runs).values({
      id: rootRunId,
      projectId,
      rootRunId,
      status: "Failed",
      runKind: "flow",
      flowVersion: "v1.0.0",
      startedAt: new Date(base - 3000),
    });
    await seedRun({
      rootRunId,
      status: "Failed",
      startedAt: new Date(base - 2000),
    });
    await seedRun({
      rootRunId,
      status: "Crashed",
      startedAt: new Date(base - 1000),
    });

    expect(await consecutiveFailedRuns({ rootRunId }, opts())).toBe(3);
  });

  it("consecutiveFailedRuns scopes by tree without leaking other trees", async () => {
    const rootRunId = randomUUID();
    const otherRoot = randomUUID();
    const base = Date.now();

    await db.insert(schema.runs).values({
      id: rootRunId,
      projectId,
      rootRunId,
      status: "Failed",
      runKind: "flow",
      flowVersion: "v1.0.0",
      startedAt: new Date(base - 1000),
    });
    // A newer failed run in a DIFFERENT tree must not be counted.
    await db.insert(schema.runs).values({
      id: otherRoot,
      projectId,
      rootRunId: otherRoot,
      status: "Failed",
      runKind: "flow",
      flowVersion: "v1.0.0",
      startedAt: new Date(base),
    });

    expect(await consecutiveFailedRuns({ rootRunId }, opts())).toBe(1);
  });
});

describe("budget aggregation — tree wall-clock", () => {
  it("treeWallClockMinutes returns whole minutes since the root run started_at", async () => {
    const rootRunId = randomUUID();

    await db.insert(schema.runs).values({
      id: rootRunId,
      projectId,
      rootRunId,
      status: "WaitingOnChildren",
      runKind: "flow",
      flowVersion: "v1.0.0",
      startedAt: new Date(Date.now() - 42 * 60_000 - 5_000),
    });

    const minutes = await treeWallClockMinutes(rootRunId, opts());

    // ~42 minutes elapsed; allow a 1-minute tolerance for test execution time.
    expect(minutes).toBeGreaterThanOrEqual(42);
    expect(minutes).toBeLessThanOrEqual(43);
  });

  it("treeWallClockMinutes returns 0 for a missing root run", async () => {
    expect(await treeWallClockMinutes(randomUUID(), opts())).toBe(0);
  });
});
