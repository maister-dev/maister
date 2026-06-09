import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
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

import * as schemaModule from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let claimLifecycleOperation: typeof import("@/lib/workbench-lifecycle/service").claimLifecycleOperation;
let finalizeLifecycleOperation: typeof import("@/lib/workbench-lifecycle/service").finalizeLifecycleOperation;
let recordDrop: typeof import("@/lib/workbench-lifecycle/service").recordDrop;

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("workbench_lifecycle_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ claimLifecycleOperation, finalizeLifecycleOperation, recordDrop } =
    await import("@/lib/workbench-lifecycle/service"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(schema.workspaces);
  await db.delete(schema.runs);
  await db.delete(schema.tasks);
  await db.delete(schema.flows);
  await db.delete(schema.platformAcpRunners);
  await db.delete(schema.projects);
});

async function seedWorkspace(): Promise<{
  runId: string;
  workspaceId: string;
}> {
  const projectId = randomUUID();
  const runnerId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `claim-${projectId.slice(0, 8)}`,
    name: "Claim Project",
    repoPath: `/tmp/claim-${projectId.slice(0, 8)}`,
    maisterYamlPath: `/tmp/claim-${projectId.slice(0, 8)}/maister.yaml`,
  });

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    title: "Lifecycle claim",
    prompt: "claim safely",
    flowId,
  });

  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(runnerId),
    status: "Review",
    flowVersion: "v1.0.0",
  });

  await db.insert(schema.workspaces).values({
    id: workspaceId,
    runId,
    projectId,
    branch: `maister/${runId}`,
    worktreePath: `/tmp/worktrees/${runId}`,
    parentRepoPath: `/tmp/claim-${projectId.slice(0, 8)}`,
  });

  return { runId, workspaceId };
}

describe("workbench lifecycle claim persistence", () => {
  it("blocks concurrent owners, reclaims failed claims, and clears completed claims", async () => {
    const { runId, workspaceId } = await seedWorkspace();
    const first = await claimLifecycleOperation({
      runId,
      workspaceId,
      operation: "archive",
    });

    await expect(
      claimLifecycleOperation({ runId, workspaceId, operation: "drop" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await finalizeLifecycleOperation({
      workspaceId,
      attemptId: first.attemptId,
      state: "failed",
    });

    const retry = await claimLifecycleOperation({
      runId,
      workspaceId,
      operation: "drop",
    });

    await finalizeLifecycleOperation({
      workspaceId,
      attemptId: retry.attemptId,
      state: "done",
    });

    const [row] = await db
      .select({
        lifecycleOperationState: schema.workspaces.lifecycleOperationState,
        lifecycleOperationName: schema.workspaces.lifecycleOperationName,
        lifecycleOperationAttemptId:
          schema.workspaces.lifecycleOperationAttemptId,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));

    expect(row).toEqual({
      lifecycleOperationState: "none",
      lifecycleOperationName: null,
      lifecycleOperationAttemptId: null,
    });
  });

  it("reclaims stale claiming rows left behind by crashed lifecycle attempts", async () => {
    const { runId, workspaceId } = await seedWorkspace();
    const staleAttemptId = randomUUID();

    await db
      .update(schema.workspaces)
      .set({
        lifecycleOperationState: "claiming",
        lifecycleOperationClaimedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        lifecycleOperationAttemptId: staleAttemptId,
        lifecycleOperationName: "archive",
      })
      .where(eq(schema.workspaces.id, workspaceId));

    const claim = await claimLifecycleOperation({
      runId,
      workspaceId,
      operation: "drop",
    });

    expect(claim.attemptId).not.toBe(staleAttemptId);

    const [row] = await db
      .select({
        lifecycleOperationState: schema.workspaces.lifecycleOperationState,
        lifecycleOperationAttemptId:
          schema.workspaces.lifecycleOperationAttemptId,
        lifecycleOperationName: schema.workspaces.lifecycleOperationName,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));

    expect(row).toMatchObject({
      lifecycleOperationState: "claiming",
      lifecycleOperationAttemptId: claim.attemptId,
      lifecycleOperationName: "drop",
    });
  });

  it("recordDrop refuses to abandon a run whose status changed after context load", async () => {
    const { runId, workspaceId } = await seedWorkspace();

    await db
      .update(schema.runs)
      .set({ status: "Done" })
      .where(eq(schema.runs.id, runId));

    await expect(
      recordDrop({
        runId,
        runKind: "flow",
        workspaceId,
        removedAt: new Date("2026-06-09T08:00:00.000Z"),
        expectedRunStatus: "Review",
        nextRunStatus: "Abandoned",
        archivedBranch: null,
        archivedAt: null,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const [run] = await db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    const [workspace] = await db
      .select({ removedAt: schema.workspaces.removedAt })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));

    expect(run).toEqual({ status: "Done" });
    expect(workspace).toEqual({ removedAt: null });
  });
});
