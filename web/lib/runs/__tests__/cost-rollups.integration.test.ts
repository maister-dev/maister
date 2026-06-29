// ADR-117 Phase 1: reconcileRunCostRollups joins run_sessions to populate the
// new run_cost_rollups.by_runner breakdown. Cost records carry sessionName
// (M42/ADR-114); each maps to exactly one runner via (run_id, session_name) →
// run_sessions.runner_snapshot, bucketed under the stable label
// "<adapter>/<model>" ("unknown" when no run_sessions row matches).
//
// Harness mirrors budget-aggregation.integration.test.ts (testcontainers
// postgres:16-alpine, drizzle migrate), plus an on-disk cost.jsonl fixture
// under a temp runtimeRoot — reconcile reads the file, not a seeded rollup.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { reconcileRunCostRollups } from "@/lib/runs/cost-rollups";

const schema = schemaModule as unknown as Record<string, any>;

const PROJECT_SLUG = "cost-app";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let runtimeRoot: string;

const client = (): NodePgDatabase<any> => db as NodePgDatabase<any>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("cost_rollups_test")
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
    slug: PROJECT_SLUG,
    name: "Cost App",
    repoPath: "/repos/cost-app",
    maisterYamlPath: "/repos/cost-app/maister.yaml",
  });

  runtimeRoot = await mkdtemp(path.join(tmpdir(), "cost-rollups-"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(schema.nodeAttemptCostRollups);
  await db.delete(schema.runCostRollups);
  await db.delete(schema.runSessions);
  await db.delete(schema.nodeAttempts);
  await db.delete(schema.runs);
  await db.delete(schema.tasks);
});

async function seedRun(opts: {
  taskId?: string | null;
  runKind?: string;
}): Promise<string> {
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    taskId: opts.taskId ?? null,
    projectId,
    status: "Done",
    runKind: opts.runKind ?? "flow",
    flowVersion: "v1.0.0",
    startedAt: new Date(),
    endedAt: new Date(),
  });

  return runId;
}

function snapshot(adapter: string, model: string): Record<string, unknown> {
  return {
    id: randomUUID(),
    adapter,
    capabilityAgent: adapter,
    model,
    providerKind: "anthropic",
    permissionPolicy: "auto",
  };
}

async function seedSession(opts: {
  runId: string;
  sessionName: string;
  adapter: string;
  model: string;
}): Promise<void> {
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId: opts.runId,
    sessionName: opts.sessionName,
    runnerSnapshot: snapshot(opts.adapter, opts.model),
  });
}

type CostLine = {
  sessionName?: string;
  model?: string;
  nodeAttemptId?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

async function writeCostJsonl(runId: string, lines: CostLine[]): Promise<void> {
  const dir = path.join(runtimeRoot, ".maister", PROJECT_SLUG, "runs", runId);

  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "cost.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n"),
    "utf8",
  );
}

async function readByRunner(
  runId: string,
): Promise<Record<string, Record<string, number>>> {
  const [row] = await db
    .select({ byRunner: schema.runCostRollups.byRunner })
    .from(schema.runCostRollups)
    .where(eq(schema.runCostRollups.runId, runId));

  return (row?.byRunner ?? {}) as Record<string, Record<string, number>>;
}

describe("reconcileRunCostRollups — by_runner", () => {
  it("buckets a single-session run under its snapshot's adapter/model", async () => {
    const runId = await seedRun({});

    await seedSession({
      runId,
      sessionName: "default",
      adapter: "claude",
      model: "claude-sonnet-4-6",
    });
    await writeCostJsonl(runId, [
      { sessionName: "default", model: "claude-sonnet-4-6", input_tokens: 10 },
      {
        sessionName: "default",
        model: "claude-sonnet-4-6",
        output_tokens: 5,
        cache_creation_input_tokens: 2,
      },
    ]);

    await reconcileRunCostRollups(runId, { client: client(), runtimeRoot });

    expect(await readByRunner(runId)).toEqual({
      "claude/claude-sonnet-4-6": {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 2,
      },
    });
  });

  it("splits two sessions across two distinct runners", async () => {
    const runId = await seedRun({});

    await seedSession({
      runId,
      sessionName: "plan",
      adapter: "claude",
      model: "claude-sonnet-4-6",
    });
    await seedSession({
      runId,
      sessionName: "review",
      adapter: "codex",
      model: "gpt-5",
    });
    await writeCostJsonl(runId, [
      { sessionName: "plan", model: "claude-sonnet-4-6", input_tokens: 100 },
      {
        sessionName: "review",
        model: "gpt-5",
        input_tokens: 20,
        output_tokens: 7,
      },
    ]);

    await reconcileRunCostRollups(runId, { client: client(), runtimeRoot });

    expect(await readByRunner(runId)).toEqual({
      "claude/claude-sonnet-4-6": {
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      "codex/gpt-5": {
        inputTokens: 20,
        outputTokens: 7,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
  });

  it("collapses a single-session flow with multiple nodes into one runner bucket (D2a)", async () => {
    const taskId = randomUUID();

    await db.insert(schema.tasks).values({
      id: taskId,
      number: Math.trunc(Math.random() * 1e9) + 1,
      projectId,
      title: "t",
      prompt: "p",
      status: "InFlight",
    });
    const runId = await seedRun({ taskId });

    await seedSession({
      runId,
      sessionName: "default",
      adapter: "claude",
      model: "claude-sonnet-4-6",
    });
    // Two different nodes, both on the single "default" session.
    await writeCostJsonl(runId, [
      {
        sessionName: "default",
        model: "claude-sonnet-4-6",
        nodeAttemptId: "a1",
        input_tokens: 10,
      },
      {
        sessionName: "default",
        model: "claude-sonnet-4-6",
        nodeAttemptId: "a2",
        input_tokens: 5,
      },
    ]);

    await reconcileRunCostRollups(runId, { client: client(), runtimeRoot });

    const byRunner = await readByRunner(runId);

    expect(Object.keys(byRunner)).toEqual(["claude/claude-sonnet-4-6"]);
    expect(byRunner["claude/claude-sonnet-4-6"].inputTokens).toBe(15);
  });

  it("buckets cost whose sessionName has no run_sessions row under 'unknown'", async () => {
    const runId = await seedRun({});

    await seedSession({
      runId,
      sessionName: "default",
      adapter: "claude",
      model: "claude-sonnet-4-6",
    });
    await writeCostJsonl(runId, [
      { sessionName: "default", model: "claude-sonnet-4-6", input_tokens: 10 },
      // No run_sessions row for "ghost" → "unknown" bucket.
      { sessionName: "ghost", model: "claude-sonnet-4-6", input_tokens: 4 },
    ]);

    await reconcileRunCostRollups(runId, { client: client(), runtimeRoot });

    const byRunner = await readByRunner(runId);

    expect(byRunner["claude/claude-sonnet-4-6"].inputTokens).toBe(10);
    expect(byRunner.unknown.inputTokens).toBe(4);
  });

  it("refreshes by_runner with no stale key when a session's runner changes", async () => {
    const runId = await seedRun({});

    await seedSession({
      runId,
      sessionName: "default",
      adapter: "claude",
      model: "claude-sonnet-4-6",
    });
    await writeCostJsonl(runId, [
      { sessionName: "default", model: "claude-sonnet-4-6", input_tokens: 10 },
    ]);

    await reconcileRunCostRollups(runId, { client: client(), runtimeRoot });
    expect(Object.keys(await readByRunner(runId))).toEqual([
      "claude/claude-sonnet-4-6",
    ]);

    // The session is rebound to a different runner; re-reconcile must not leave
    // the old key behind.
    await db
      .update(schema.runSessions)
      .set({ runnerSnapshot: snapshot("codex", "gpt-5") })
      .where(eq(schema.runSessions.runId, runId));

    await reconcileRunCostRollups(runId, { client: client(), runtimeRoot });

    expect(Object.keys(await readByRunner(runId))).toEqual(["codex/gpt-5"]);
  });

  it("writes by_runner for a scratch run with no task or node attempts and keeps run totals", async () => {
    const runId = await seedRun({ runKind: "scratch" });

    await seedSession({
      runId,
      sessionName: "default",
      adapter: "claude",
      model: "claude-sonnet-4-6",
    });
    await writeCostJsonl(runId, [
      {
        sessionName: "default",
        model: "claude-sonnet-4-6",
        input_tokens: 30,
        output_tokens: 12,
      },
    ]);

    await reconcileRunCostRollups(runId, { client: client(), runtimeRoot });

    const [row] = await db
      .select({
        inputTokens: schema.runCostRollups.inputTokens,
        outputTokens: schema.runCostRollups.outputTokens,
        byRunner: schema.runCostRollups.byRunner,
      })
      .from(schema.runCostRollups)
      .where(eq(schema.runCostRollups.runId, runId));

    expect(row.inputTokens).toBe(30);
    expect(row.outputTokens).toBe(12);
    expect(row.byRunner).toEqual({
      "claude/claude-sonnet-4-6": {
        inputTokens: 30,
        outputTokens: 12,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
  });
});
