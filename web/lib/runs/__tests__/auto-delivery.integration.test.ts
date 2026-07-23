import type { ExecutionPolicy } from "@/lib/runs/execution-policy";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
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
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
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
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
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

// ADR-149 (enforcing ADR-142 D3): a launched-lineage run (a launched evaluation
// participant) NEVER auto-promotes — winner promotion is the explicit human
// path. The two implemented arms (the ADR-126 sweep SQL prefilter + the evaluate
// `not_applicable` term) do NOT cover the auto_on_ready autopilot that reaches
// promotion through deliverRunIfAutoReady → promoteRun. These regressions pin the
// choke-point guard + the ordering short-circuit that close that hole. The
// exclusion is now via `evaluation_participants.source_type='launched'` — the
// retired `experiment_runs` leg of isLaunchedLineageRun was dropped in ADR-149.
async function seedLaunchedParticipant(runId: string): Promise<void> {
  const taskId = randomUUID();

  await db.insert(schema.tasks).values({
    id: taskId,
    number: 1,
    projectId,
    title: "member task",
    prompt: "compare",
  });

  const studyId = randomUUID();

  await db.insert(schema.evaluationStudies).values({
    id: studyId,
    projectId,
    taskId,
    title: "fork vs upstream",
    status: "open",
  });

  const recipeId = randomUUID();

  await db.insert(schema.evaluationRecipes).values({
    id: recipeId,
    studyId,
    key: "a",
    label: "A",
    definition: {},
    definitionDigest: "d",
  });

  await db.insert(schema.evaluationParticipants).values({
    id: randomUUID(),
    studyId,
    runId,
    sourceType: "launched",
    recipeId,
    label: "launched",
    launchReason: "initial",
    replicateOrdinal: 1,
  });
}

describe("ADR-149 launched-lineage auto-promotion exclusion", () => {
  it("short-circuits a launched-lineage run WITHOUT degrading its delivery policy", async () => {
    const runId = await seedReviewRun({
      executionPolicy: { preset: "unattended" },
      deliveryPolicySnapshot: autoDelivery,
    });

    await seedLaunchedParticipant(runId);
    const promote = mockPromote();

    await deliverRunIfAutoReady(runId, db, promote);

    expect(promote).not.toHaveBeenCalled();

    // The member must NOT be degraded to manual — it simply stays in Review
    // for the human study-decision path.
    const [row] = (await db
      .select({ deliveryPolicySnapshot: schema.runs.deliveryPolicySnapshot })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))) as Array<Record<string, any>>;

    expect(row.deliveryPolicySnapshot).toMatchObject({
      trigger: "auto_on_ready",
    });
  });

  it("refuses at the promote choke point when an autopilot reaches a member run", async () => {
    const runId = await seedReviewRun({
      executionPolicy: { preset: "unattended" },
      deliveryPolicySnapshot: autoDelivery,
    });

    await seedLaunchedParticipant(runId);

    await expect(
      promoteRun(
        runId,
        { mode: "local_merge", autoOnReady: true },
        { sessionUser: { id: userId }, authorize: async () => undefined },
        db,
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { launchedLineage: true },
    });
  });

  it("does NOT block the explicit human winner-promote (guard is actor-gated, not membership-gated)", async () => {
    const runId = await seedReviewRun({
      executionPolicy: { preset: "supervised" },
      deliveryPolicySnapshot: manualDelivery,
    });

    await seedLaunchedParticipant(runId);

    let caught: any;

    try {
      await promoteRun(
        runId,
        { mode: "local_merge" },
        { sessionUser: { id: userId }, authorize: async () => undefined },
        db,
      );
    } catch (err) {
      caught = err;
    }

    // A human promote passes the guard and fails later (no workspace), never
    // with the launched-lineage refusal.
    expect(caught?.details?.launchedLineage).toBeUndefined();
  });
});
