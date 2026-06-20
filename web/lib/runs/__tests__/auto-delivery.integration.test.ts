import type { ExecutionPolicy } from "@/lib/runs/execution-policy";

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { deliverRunIfAutoReady } from "@/lib/runs/auto-delivery";
import { promoteRun } from "@/lib/runs/promote";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let userId: string;
let runnerId: string;
let flowId: string;

const manualDelivery = {
  strategy: "local_merge",
  push: "never",
  trigger: "manual",
  targetBranch: "main",
};
const autoDelivery = { ...manualDelivery, trigger: "auto_on_ready" };

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
  await pool.query(`DELETE FROM "flows"`);
  await pool.query(`DELETE FROM "platform_acp_runners"`);
  await pool.query(`DELETE FROM "projects"`);
  await pool.query(`DELETE FROM "users"`);

  projectId = randomUUID();
  userId = randomUUID();
  runnerId = randomUUID();
  flowId = randomUUID();

  await db
    .insert(schema.users)
    .values({ id: userId, email: `u-${userId.slice(0, 8)}@t.test` });
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

async function seedReviewRun(args: {
  executionPolicy: ExecutionPolicy;
  deliveryPolicySnapshot: unknown;
  status?: string;
}): Promise<string> {
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    flowId,
    runnerId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(runnerId),
    flowVersion: "v1.0.0",
    status: args.status ?? "Review",
    createdByUserId: userId,
    deliveryPolicySnapshot: args.deliveryPolicySnapshot,
    executionPolicy: args.executionPolicy,
  });

  return runId;
}

function mockPromote() {
  return vi.fn(
    async (..._args: Parameters<typeof promoteRun>) =>
      ({}) as Awaited<ReturnType<typeof promoteRun>>,
  );
}

describe("deliverRunIfAutoReady — C1 OR-combine with execution policy", () => {
  it("auto-promotes when the EXECUTION policy is auto_on_ready even if delivery is manual", async () => {
    const runId = await seedReviewRun({
      executionPolicy: { preset: "unattended" },
      deliveryPolicySnapshot: manualDelivery,
    });
    const promote = mockPromote();

    await deliverRunIfAutoReady(runId, db, promote);

    expect(promote).toHaveBeenCalledTimes(1);
    expect(promote).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ autoOnReady: true }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("does NOT auto-promote when both execution and delivery are manual", async () => {
    const runId = await seedReviewRun({
      executionPolicy: { preset: "supervised" },
      deliveryPolicySnapshot: manualDelivery,
    });
    const promote = mockPromote();

    await deliverRunIfAutoReady(runId, db, promote);

    expect(promote).not.toHaveBeenCalled();
  });

  it("still auto-promotes on the delivery-policy trigger (existing behavior preserved)", async () => {
    const runId = await seedReviewRun({
      executionPolicy: { preset: "supervised" },
      deliveryPolicySnapshot: autoDelivery,
    });
    const promote = mockPromote();

    await deliverRunIfAutoReady(runId, db, promote);

    expect(promote).toHaveBeenCalledTimes(1);
  });

  it("does NOT promote a run that is not in Review", async () => {
    const runId = await seedReviewRun({
      executionPolicy: { preset: "unattended" },
      deliveryPolicySnapshot: manualDelivery,
      status: "Running",
    });
    const promote = mockPromote();

    await deliverRunIfAutoReady(runId, db, promote);

    expect(promote).not.toHaveBeenCalled();
  });
});
