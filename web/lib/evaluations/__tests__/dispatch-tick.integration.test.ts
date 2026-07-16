import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { readEvaluationEvents } from "@/lib/evaluations/dispatcher/events";
import { startEvaluationExecution } from "@/lib/evaluations/dispatcher/start";
import {
  runEvaluationDispatchTick,
  type EvaluationDispatchDeps,
} from "@/lib/evaluations/dispatcher/tick";
import { evaluateAndAdvancePanel } from "@/lib/evaluations/aggregation/worker";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let projectId: string;
let studyId: string;
let profileId: string;

const NORMALIZED_DEFINITION = {
  definition: {
    id: "sdd-quality",
    criteria: [
      {
        id: "correctness",
        weight: 0.6,
        scale: { min: 0, max: 5 },
        optional: false,
      },
      {
        id: "maintainability",
        weight: 0.4,
        scale: { min: 0, max: 5 },
        optional: false,
      },
    ],
    judges: { roles: [{ id: "reviewer", count: 2 }] },
    aggregation: { algorithm: "weighted_mean@1" },
    panelPolicy: { quorum: 2 },
    caps: {},
    objectiveChecks: [],
  },
  criteria: [
    { id: "correctness", normalizedWeight: 0.6 },
    { id: "maintainability", normalizedWeight: 0.4 },
  ],
};

const PANEL_POLICY = {
  attempts: 2,
  maxParallelAttempts: 1,
  quorum: 2,
  timeoutMs: 60_000,
  maxRetries: 1,
  blindLabels: true,
  randomizeOrder: true,
  allowedMcps: [],
};

// A dispatch-deps set that exercises the FSM driver WITHOUT a live agent: capture
// seals a tiny snapshot, checks are a no-op (no objective checks in this method),
// launch provisions two `running` attempts (the launch/seal machinery is tested
// separately in judge-seam), and advance is the REAL panel worker.
function stubDeps(
  overrides: Partial<EvaluationDispatchDeps> = {},
): EvaluationDispatchDeps {
  return {
    captureEvidence: async () => {
      const { sealEvidenceSnapshot } = await import(
        "@/lib/evaluations/evidence/snapshots"
      );
      const sealed = await sealEvidenceSnapshot(
        {
          studyId,
          participantWatermarks: { seed: randomUUID() },
          evidenceProtocolDigest: `p-${randomUUID()}`,
          items: [],
        },
        db,
      );

      return { snapshotId: sealed.snapshotId };
    },
    runChecks: async () => {},
    launchPanel: async (executionId) => {
      for (const ordinal of [1, 2]) {
        await db
          .insert(schema.evaluationJudgeAttempts)
          .values({
            executionId,
            role: "reviewer",
            ordinal,
            retryOrdinal: 0,
            agentId: "core:sdd-judge",
            status: "running",
            runningAt: new Date(),
          })
          .onConflictDoNothing();
      }
    },
    advancePanel: (id) => evaluateAndAdvancePanel(id, db),
    now: () => new Date(),
    ...overrides,
  };
}

async function completeAttempts(executionId: string): Promise<void> {
  const attempts = await db
    .select({ id: schema.evaluationJudgeAttempts.id })
    .from(schema.evaluationJudgeAttempts)
    .where(eq(schema.evaluationJudgeAttempts.executionId, executionId));

  for (const attempt of attempts) {
    await db
      .update(schema.evaluationJudgeAttempts)
      .set({ status: "completed", terminalAt: new Date() })
      .where(eq(schema.evaluationJudgeAttempts.id, attempt.id));

    for (const [criterionId, score] of [
      ["correctness", "4"],
      ["maintainability", "3"],
    ] as const) {
      await db.insert(schema.evaluationCriterionResults).values({
        attemptId: attempt.id,
        criterionId,
        state: "scored",
        score,
        confidence: "0.9",
      });
    }
  }
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_dispatch_test",
  });
  db = testDatabase.db;

  projectId = randomUUID();
  const taskId = randomUUID();
  const flowId = randomUUID();
  const executorId = randomUUID();

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
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", nodes: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id: taskId,
    projectId,
    title: "T",
    prompt: "p",
    flowId,
  });
  studyId = randomUUID();
  await db.insert(schema.evaluationStudies).values({
    id: studyId,
    projectId,
    taskId,
    title: "Study",
    status: "open",
  });

  // Two observed participants (runId null → capture would report unavailable,
  // but this test stubs capture, so the runs are unnecessary).
  for (const order of [0, 1]) {
    await db.insert(schema.evaluationParticipants).values({
      id: randomUUID(),
      studyId,
      runId: null,
      sourceType: "observed",
      label: `P${order}`,
      displayOrder: order,
    });
  }

  await db.insert(schema.agents).values({
    id: "core:sdd-judge",
    packageName: "core",
    versionLabel: "v1.1.0",
    origin: "git",
    name: "SDD Judge",
    description: "Evaluation judge",
    workspace: "none",
    mode: "session",
    triggers: [],
    riskTier: "read_only",
    sourcePath: "maister-agents/sdd-judge.md",
  });
  const installId = randomUUID();

  await db.insert(schema.packageInstalls).values({
    id: installId,
    sourceUrl: "github.com/x/core",
    name: "core",
    versionLabel: "v1.1.0",
    resolvedRevision: "deadbeef",
    manifest: { spec: { name: "core" } },
    manifestDigest: "d",
    installedPath: "/tmp/core",
    packageStatus: "Installed",
    trustStatus: "trusted",
  });
  const methodRevisionId = randomUUID();

  await db.insert(schema.evaluationMethodRevisions).values({
    id: methodRevisionId,
    packageInstallId: installId,
    methodId: "sdd-quality",
    qualifiedId: "core:sdd-quality",
    packageName: "core",
    versionLabel: "v1.1.0",
    schemaVersion: 1,
    normalizedDefinition: NORMALIZED_DEFINITION,
    definitionDigest: "dd",
    promptDigest: "pd",
    schemaDigest: "sd",
    compat: { engineMin: "3.2.0" },
    activation: "enabled",
  });
  const panelId = randomUUID();

  await db.insert(schema.evaluationJudgePanels).values({
    id: panelId,
    name: "SDD Panel",
    roleBindings: [{ role: "reviewer", agentId: "core:sdd-judge" }],
    policy: PANEL_POLICY,
    enabled: true,
  });
  profileId = randomUUID();
  await db.insert(schema.evaluationProfiles).values({
    id: profileId,
    name: "SDD Profile",
    methodRevisionId,
    panelId,
    allowedOverrides: {},
    hardLimits: {},
    enabled: true,
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function statusOf(executionId: string): Promise<string> {
  const [row] = await db
    .select({ status: schema.evaluationExecutions.status })
    .from(schema.evaluationExecutions)
    .where(eq(schema.evaluationExecutions.id, executionId));

  return row.status;
}

describe("evaluation dispatch tick", () => {
  it("starts an execution and drives queued -> capturing -> checking -> judging", async () => {
    const { executionId } = await startEvaluationExecution(
      { studyId, projectId, profileId },
      db,
    );

    expect(await statusOf(executionId)).toBe("queued");

    await runEvaluationDispatchTick(stubDeps(), db);

    expect(await statusOf(executionId)).toBe("judging");

    // The durable, replayable event log carries every waiting-state transition.
    const events = await readEvaluationEvents({ studyId }, db);
    const types = events
      .filter((e) => e.executionId === executionId)
      .map((e) => e.eventType);

    expect(types).toContain("evaluation.queued");
    expect(types).toContain("evidence.capture_started");
    expect(types).toContain("evidence.snapshot_sealed");
    expect(types).toContain("objective_check.completed");
  });

  it("completes the panel to `completed` once quorum of valid attempts is met", async () => {
    const { executionId } = await startEvaluationExecution(
      { studyId, projectId, profileId },
      db,
    );

    await runEvaluationDispatchTick(stubDeps(), db);
    expect(await statusOf(executionId)).toBe("judging");

    await completeAttempts(executionId);
    await runEvaluationDispatchTick(stubDeps(), db);

    expect(await statusOf(executionId)).toBe("completed");

    const [aggregate] = await db
      .select({ id: schema.evaluationAggregateResults.id })
      .from(schema.evaluationAggregateResults)
      .where(eq(schema.evaluationAggregateResults.executionId, executionId));

    expect(aggregate).toBeTruthy();
  });

  it("poisons a capture failure to `failed` and queues a retry_of successor", async () => {
    const { executionId } = await startEvaluationExecution(
      { studyId, projectId, profileId },
      db,
    );

    const failing = stubDeps({
      captureEvidence: async () => {
        throw new Error("simulated capture failure");
      },
    });

    await runEvaluationDispatchTick(failing, db);

    expect(await statusOf(executionId)).toBe("failed");

    // maxRetries = 1 → exactly one retry_of successor is queued.
    const successors = await db
      .select({ id: schema.evaluationExecutions.id })
      .from(schema.evaluationExecutions)
      .where(
        and(
          eq(schema.evaluationExecutions.retryOf, executionId),
          eq(schema.evaluationExecutions.status, "queued"),
        ),
      );

    expect(successors).toHaveLength(1);
  });

  it("reaps a timed-out running attempt and terminalizes the panel to partial", async () => {
    const { executionId } = await startEvaluationExecution(
      { studyId, projectId, profileId },
      db,
    );

    await runEvaluationDispatchTick(stubDeps(), db);
    expect(await statusOf(executionId)).toBe("judging");

    // Backdate both running attempts past the 60s timeout.
    await db
      .update(schema.evaluationJudgeAttempts)
      .set({ runningAt: new Date(Date.now() - 120_000) })
      .where(eq(schema.evaluationJudgeAttempts.executionId, executionId));

    const summary = await runEvaluationDispatchTick(stubDeps(), db);

    expect(summary.timedOutAttempts).toBeGreaterThanOrEqual(2);
    // All attempts terminal (timed_out), quorum unmet → partial.
    expect(await statusOf(executionId)).toBe("partial");
  });
});
