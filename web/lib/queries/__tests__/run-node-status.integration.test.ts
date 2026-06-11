import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches run-timeline.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let getRunNodeStatuses: typeof import("@/lib/queries/run-node-status").getRunNodeStatuses;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("run_node_status_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ getRunNodeStatuses } = await import("@/lib/queries/run-node-status"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

// Seed a real flows + runs row (flow_id is NOT NULL + FK) — same shape as
// run-timeline.integration's seedRun.
async function seedRun(): Promise<{ projectId: string; runId: string }> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: "Node Status Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "aif",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/aif",
    manifest: { schemaVersion: 1, name: "aif", nodes: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({ number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    status: "Running",
    currentStepId: "checks",
    flowVersion: "v1.0.0",
  });

  return { projectId, runId };
}

describe("getRunNodeStatuses (integration)", () => {
  it("reflects a fresh node_attempts row's status, its blocking-gate rollup, and the run's currentStepId/status", async () => {
    const { runId } = await seedRun();

    const checksAttemptId = randomUUID();

    await db.insert(schema.nodeAttempts).values({
      id: checksAttemptId,
      runId,
      nodeId: "checks",
      nodeType: "check",
      attempt: 1,
      status: "Failed",
      startedAt: new Date("2026-06-01T10:00:00.000Z"),
    });
    await db.insert(schema.gateResults).values({
      id: randomUUID(),
      runId,
      nodeAttemptId: checksAttemptId,
      gateId: "lint",
      kind: "command_check",
      mode: "blocking",
      status: "failed",
      verdict: { verdict: "fail" },
      createdAt: new Date("2026-06-01T10:00:30.000Z"),
    });

    const result = await getRunNodeStatuses(runId);

    expect(result.runStatus).toBe("Running");
    expect(result.currentStepId).toBe("checks");
    expect(result.nodes.checks.status).toBe("Failed");
    expect(result.nodes.checks.attempt).toBe(1);
    expect(result.nodes.checks.gates).toEqual([
      { blocking: true, status: "failed" },
    ]);
    expect(result.nodes.checks.rollup).toBe("failed");
  });

  it("keeps the highest-attempt status for a node with multiple attempts", async () => {
    const { runId } = await seedRun();

    await db.insert(schema.nodeAttempts).values({
      id: randomUUID(),
      runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Failed",
      startedAt: new Date("2026-06-01T11:00:00.000Z"),
    });
    await db.insert(schema.nodeAttempts).values({
      id: randomUUID(),
      runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 2,
      status: "Succeeded",
      startedAt: new Date("2026-06-01T11:05:00.000Z"),
    });

    const result = await getRunNodeStatuses(runId);

    expect(result.nodes.implement.status).toBe("Succeeded");
    expect(result.nodes.implement.attempt).toBe(2);
  });
});
