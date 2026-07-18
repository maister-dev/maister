import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { readEvaluationEvents } from "@/lib/evaluations/dispatcher/events";
import {
  deriveEvidenceProtocolDigest,
  startEvaluationExecution,
} from "@/lib/evaluations/dispatcher/start";
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
let db: NodePgDatabase<typeof fullSchema>;
let projectId: string;
let studyId: string;
let profileId: string;
let methodRevisionId: string;

const NORMALIZED_DEFINITION = {
  definition: {
    id: "sdd-quality",
    evidence: { captureBudgetBytes: 65536, requiredCoverage: [] },
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
  methodRevisionId = randomUUID();

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

describe("startEvaluationExecution idempotency + start gates", () => {
  it("replays the same key + same request onto the original execution", async () => {
    const key = randomUUID();
    const first = await startEvaluationExecution(
      { studyId, projectId, profileId, idempotencyKey: key },
      db,
    );
    const second = await startEvaluationExecution(
      { studyId, projectId, profileId, idempotencyKey: key },
      db,
    );

    expect(first.deduped).toBe(false);
    expect(second).toEqual({ executionId: first.executionId, deduped: true });

    const rows = await db
      .select({ id: schema.evaluationExecutions.id })
      .from(schema.evaluationExecutions)
      .where(
        and(
          eq(schema.evaluationExecutions.studyId, studyId),
          eq(schema.evaluationExecutions.idempotencyKey, key),
        ),
      );

    expect(rows).toHaveLength(1);
  });

  it("rejects the same key reused for a different request (digest mismatch)", async () => {
    const [profileRow] = await db
      .select()
      .from(schema.evaluationProfiles)
      .where(eq(schema.evaluationProfiles.id, profileId));
    const otherProfileId = randomUUID();

    await db.insert(schema.evaluationProfiles).values({
      id: otherProfileId,
      name: "SDD Profile B",
      methodRevisionId: profileRow.methodRevisionId,
      panelId: profileRow.panelId,
      allowedOverrides: {},
      hardLimits: {},
      enabled: true,
    });

    const key = randomUUID();

    await startEvaluationExecution(
      { studyId, projectId, profileId, idempotencyKey: key },
      db,
    );

    await expect(
      startEvaluationExecution(
        { studyId, projectId, profileId: otherProfileId, idempotencyKey: key },
        db,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/already used for a different request/),
    });
  });

  it("scopes the idempotency key to the study (no cross-study dedup)", async () => {
    const [studyRow] = await db
      .select()
      .from(schema.evaluationStudies)
      .where(eq(schema.evaluationStudies.id, studyId));
    const otherStudyId = randomUUID();

    await db.insert(schema.evaluationStudies).values({
      id: otherStudyId,
      projectId,
      taskId: studyRow.taskId,
      title: "Study B",
      status: "open",
    });

    const key = randomUUID();
    const first = await startEvaluationExecution(
      { studyId, projectId, profileId, idempotencyKey: key },
      db,
    );
    const second = await startEvaluationExecution(
      { studyId: otherStudyId, projectId, profileId, idempotencyKey: key },
      db,
    );

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(false);
    expect(second.executionId).not.toBe(first.executionId);
  });

  it("converges two concurrent same-key first submits on one execution (no raw 23505)", async () => {
    const key = randomUUID();
    const args = { studyId, projectId, profileId, idempotencyKey: key };

    const settled = await Promise.allSettled([
      startEvaluationExecution(args, db),
      startEvaluationExecution(args, db),
    ]);
    const rejections = settled.filter((s) => s.status === "rejected");

    // Never a raw unique-violation leak — the loser converges on the winner.
    expect(
      rejections.map((r) => String((r as PromiseRejectedResult).reason)),
    ).toEqual([]);

    const results = settled.flatMap((s) =>
      s.status === "fulfilled" ? [s.value] : [],
    );

    expect(results).toHaveLength(2);
    expect(new Set(results.map((r) => r.executionId)).size).toBe(1);
    expect(results.map((r) => r.deduped).sort()).toEqual([false, true]);

    const rows = await db
      .select({ id: schema.evaluationExecutions.id })
      .from(schema.evaluationExecutions)
      .where(
        and(
          eq(schema.evaluationExecutions.studyId, studyId),
          eq(schema.evaluationExecutions.idempotencyKey, key),
        ),
      );

    expect(rows).toHaveLength(1);
  });

  it("refuses to start a pairwise_tournament method (fail-closed CONFIG gate)", async () => {
    const [profileRow] = await db
      .select()
      .from(schema.evaluationProfiles)
      .where(eq(schema.evaluationProfiles.id, profileId));
    const [methodRow] = await db
      .select()
      .from(schema.evaluationMethodRevisions)
      .where(
        eq(schema.evaluationMethodRevisions.id, profileRow.methodRevisionId),
      );
    const pairwiseMethodRevisionId = randomUUID();

    await db.insert(schema.evaluationMethodRevisions).values({
      id: pairwiseMethodRevisionId,
      packageInstallId: methodRow.packageInstallId,
      methodId: "pairwise-quality",
      qualifiedId: "core:pairwise-quality",
      packageName: "core",
      versionLabel: "v1.1.0",
      schemaVersion: 1,
      normalizedDefinition: {
        ...NORMALIZED_DEFINITION,
        definition: {
          ...NORMALIZED_DEFINITION.definition,
          id: "pairwise-quality",
          aggregation: { algorithm: "pairwise_tournament@1" },
        },
      },
      definitionDigest: "dd-pairwise",
      promptDigest: "pd",
      schemaDigest: "sd",
      compat: { engineMin: "3.2.0" },
      activation: "enabled",
    });
    const pairwiseProfileId = randomUUID();

    await db.insert(schema.evaluationProfiles).values({
      id: pairwiseProfileId,
      name: "Pairwise Profile",
      methodRevisionId: pairwiseMethodRevisionId,
      panelId: profileRow.panelId,
      allowedOverrides: {},
      hardLimits: {},
      enabled: true,
    });

    await expect(
      startEvaluationExecution(
        { studyId, projectId, profileId: pairwiseProfileId },
        db,
      ),
    ).rejects.toMatchObject({
      code: "CONFIG",
      message: expect.stringMatching(
        /pairwise_tournament methods are not executable yet/,
      ),
    });

    // Fail-closed at start: no execution row was created for the method.
    const rows = await db
      .select({ id: schema.evaluationExecutions.id })
      .from(schema.evaluationExecutions)
      .where(
        eq(
          schema.evaluationExecutions.methodRevisionId,
          pairwiseMethodRevisionId,
        ),
      );

    expect(rows).toHaveLength(0);
  });
});

describe("dispatch liveness fixes", () => {
  it("passes the snapshotted method definition to the evidence-protocol digest (not a constant)", async () => {
    const { executionId } = await startEvaluationExecution(
      { studyId, projectId, profileId },
      db,
    );

    const seen: string[] = [];
    const deps = stubDeps();
    const recordingDeps: EvaluationDispatchDeps = {
      ...deps,
      captureEvidence: async (args) => {
        if (args.executionId === executionId) {
          seen.push(args.evidenceProtocolDigest);
        }

        return deps.captureEvidence(args);
      },
    };

    await runEvaluationDispatchTick(recordingDeps, db);

    expect(await statusOf(executionId)).toBe("judging");
    expect(seen).toEqual([
      deriveEvidenceProtocolDigest(NORMALIZED_DEFINITION.definition),
    ]);
  });

  it("two-racer poison: a concurrent tick+kick never terminalizes the claim winner's live execution", async () => {
    const executionIds: string[] = [];

    for (let i = 0; i < 6; i++) {
      const { executionId } = await startEvaluationExecution(
        { studyId, projectId, profileId, idempotencyKey: randomUUID() },
        db,
      );

      executionIds.push(executionId);
    }

    // Widen the claim race window: the capture step (which runs AFTER the
    // queued→capturing claim) sleeps briefly so both racers overlap.
    const slowDeps = (): EvaluationDispatchDeps => {
      const deps = stubDeps();

      return {
        ...deps,
        captureEvidence: async (args) => {
          await new Promise((r) => setTimeout(r, 25));

          return deps.captureEvidence(args);
        },
      };
    };

    const [a, b] = await Promise.all([
      runEvaluationDispatchTick(slowDeps(), db),
      runEvaluationDispatchTick(slowDeps(), db),
    ]);

    // The claim loser must skip, never poison the winner's live execution.
    expect(a.poisoned + b.poisoned).toBe(0);
    // Each execution driven at least once between the racers (stray queued
    // rows from earlier tests may add to the count, never subtract).
    expect(a.drivenToJudging + b.drivenToJudging).toBeGreaterThanOrEqual(
      executionIds.length,
    );

    // The winner's executions stay LIVE — the loser terminalized nothing.
    for (const id of executionIds) {
      expect(await statusOf(id)).toBe("judging");
    }
  });

  it("recovers stale capturing (poison → failed/CRASH) and stale aggregating (re-aggregate → completed)", async () => {
    const staleCapturing = randomUUID();

    await db.insert(schema.evaluationExecutions).values({
      id: staleCapturing,
      studyId,
      status: "capturing",
      version: 2,
      startedAt: new Date(Date.now() - 15 * 60_000),
      judgePolicySnapshot: { policy: { maxRetries: 0 } },
    });

    const staleAggregating = randomUUID();

    await db.insert(schema.evaluationExecutions).values({
      id: staleAggregating,
      studyId,
      status: "aggregating",
      version: 4,
      startedAt: new Date(Date.now() - 15 * 60_000),
      methodRevisionId,
    });

    for (const ordinal of [1, 2]) {
      const attemptId = randomUUID();

      await db.insert(schema.evaluationJudgeAttempts).values({
        id: attemptId,
        executionId: staleAggregating,
        role: "reviewer",
        ordinal,
        retryOrdinal: 0,
        agentId: "core:sdd-judge",
        status: "completed",
        terminalAt: new Date(),
      });
      for (const [criterionId, score] of [
        ["correctness", "4"],
        ["maintainability", "3"],
      ] as const) {
        await db.insert(schema.evaluationCriterionResults).values({
          attemptId,
          criterionId,
          state: "scored",
          score,
          confidence: "0.9",
        });
      }
    }

    const summary = await runEvaluationDispatchTick(stubDeps(), db);

    expect(summary.recovered).toBeGreaterThanOrEqual(2);
    expect(await statusOf(staleCapturing)).toBe("failed");

    const [failedRow] = await db
      .select({ terminalReason: schema.evaluationExecutions.terminalReason })
      .from(schema.evaluationExecutions)
      .where(eq(schema.evaluationExecutions.id, staleCapturing));

    expect(failedRow.terminalReason).toBe("CRASH");

    expect(await statusOf(staleAggregating)).toBe("completed");

    const aggregates = await db
      .select({ id: schema.evaluationAggregateResults.id })
      .from(schema.evaluationAggregateResults)
      .where(
        eq(schema.evaluationAggregateResults.executionId, staleAggregating),
      );

    expect(aggregates.length).toBeGreaterThanOrEqual(1);
  });

  it("recreates the missing review row for a crash-window review_required execution, damped by a fresh entry event", async () => {
    // Crash artifact: review_required with NO review.required event (recovers
    // immediately — a real crash artifact's event would be past the cutoff).
    const orphaned = randomUUID();

    await db.insert(schema.evaluationExecutions).values({
      id: orphaned,
      studyId,
      status: "review_required",
      version: 5,
    });

    // Live-worker window: review_required whose entry event is FRESH — the
    // recovery arm must NOT race the worker's own openReview.
    const inFlight = randomUUID();

    await db.insert(schema.evaluationExecutions).values({
      id: inFlight,
      studyId,
      status: "review_required",
      version: 5,
    });
    await db.insert(schema.evaluationEvents).values({
      studyId,
      executionId: inFlight,
      sequence: 900_001,
      eventType: "review.required",
      payload: {},
    });

    await runEvaluationDispatchTick(stubDeps(), db);

    const orphanReviews = await db
      .select({
        id: schema.evaluationReviews.id,
        status: schema.evaluationReviews.status,
        kind: schema.evaluationReviews.kind,
      })
      .from(schema.evaluationReviews)
      .where(eq(schema.evaluationReviews.executionId, orphaned));

    expect(orphanReviews).toHaveLength(1);
    expect(orphanReviews[0].status).toBe("required");
    expect(orphanReviews[0].kind).toBe("disagreement");

    const inFlightReviews = await db
      .select({ id: schema.evaluationReviews.id })
      .from(schema.evaluationReviews)
      .where(eq(schema.evaluationReviews.executionId, inFlight));

    expect(inFlightReviews).toHaveLength(0);
  });

  it("reap guard: a Pending-run attempt is not reaped (clock re-anchored); a started attempt is reaped with token revoked and run stopped", async () => {
    const { executionId } = await startEvaluationExecution(
      { studyId, projectId, profileId },
      db,
    );

    await runEvaluationDispatchTick(stubDeps(), db);
    expect(await statusOf(executionId)).toBe("judging");

    const attempts = await db
      .select({
        id: schema.evaluationJudgeAttempts.id,
        ordinal: schema.evaluationJudgeAttempts.ordinal,
      })
      .from(schema.evaluationJudgeAttempts)
      .where(eq(schema.evaluationJudgeAttempts.executionId, executionId))
      .orderBy(schema.evaluationJudgeAttempts.ordinal);

    expect(attempts).toHaveLength(2);

    const pendingRunId = randomUUID();
    const runningRunId = randomUUID();

    await db.insert(schema.runs).values([
      {
        id: pendingRunId,
        runKind: "agent",
        agentId: "core:sdd-judge",
        agentWorkspace: "none",
        projectId,
        status: "Pending",
        flowVersion: "v0",
      },
      {
        id: runningRunId,
        runKind: "agent",
        agentId: "core:sdd-judge",
        agentWorkspace: "none",
        projectId,
        status: "Running",
        flowVersion: "v0",
      },
    ]);

    const tokenA = randomUUID();
    const tokenB = randomUUID();

    await db.insert(schema.projectTokens).values([
      {
        id: tokenA,
        project_id: projectId,
        name: `agent-run:${pendingRunId}`,
        token_kind: "agent",
        agent_id: "core:sdd-judge",
        prefix: "tkA",
        token_hash: "hashA",
        scopes: ["evaluations:judge"],
        expires_at: new Date(Date.now() + 3_600_000),
      },
      {
        id: tokenB,
        project_id: projectId,
        name: `agent-run:${runningRunId}`,
        token_kind: "agent",
        agent_id: "core:sdd-judge",
        prefix: "tkB",
        token_hash: "hashB",
        scopes: ["evaluations:judge"],
        expires_at: new Date(Date.now() + 3_600_000),
      },
    ]);

    const backdated = new Date(Date.now() - 120_000);

    await db
      .update(schema.evaluationJudgeAttempts)
      .set({
        agentRunId: pendingRunId,
        tokenId: tokenA,
        runningAt: backdated,
      })
      .where(eq(schema.evaluationJudgeAttempts.id, attempts[0].id));
    await db
      .update(schema.evaluationJudgeAttempts)
      .set({
        agentRunId: runningRunId,
        tokenId: tokenB,
        runningAt: backdated,
      })
      .where(eq(schema.evaluationJudgeAttempts.id, attempts[1].id));

    const summary = await runEvaluationDispatchTick(stubDeps(), db);

    // >= 1: attempts of long-lived judging executions from earlier tests may
    // also cross their 60s timeout while this file runs.
    expect(summary.timedOutAttempts).toBeGreaterThanOrEqual(1);

    // The Pending-run attempt is NOT reaped; its timeout clock is re-anchored.
    const [guarded] = await db
      .select({
        status: schema.evaluationJudgeAttempts.status,
        runningAt: schema.evaluationJudgeAttempts.runningAt,
      })
      .from(schema.evaluationJudgeAttempts)
      .where(eq(schema.evaluationJudgeAttempts.id, attempts[0].id));

    expect(guarded.status).toBe("running");
    expect(guarded.runningAt!.getTime()).toBeGreaterThan(backdated.getTime());

    // The started attempt is reaped, its token revoked, its agent run stopped
    // (terminal Abandoned → the agent slot is freed and run tokens revoked).
    const [reaped] = await db
      .select({ status: schema.evaluationJudgeAttempts.status })
      .from(schema.evaluationJudgeAttempts)
      .where(eq(schema.evaluationJudgeAttempts.id, attempts[1].id));

    expect(reaped.status).toBe("timed_out");

    const [revokedToken] = await db
      .select({ revoked_at: schema.projectTokens.revoked_at })
      .from(schema.projectTokens)
      .where(eq(schema.projectTokens.id, tokenB));

    expect(revokedToken.revoked_at).not.toBeNull();

    const [guardedToken] = await db
      .select({ revoked_at: schema.projectTokens.revoked_at })
      .from(schema.projectTokens)
      .where(eq(schema.projectTokens.id, tokenA));

    expect(guardedToken.revoked_at).toBeNull();

    const [stoppedRun] = await db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, runningRunId));

    expect(stoppedRun.status).toBe("Abandoned");

    // One attempt still running → the panel is NOT terminal.
    expect(await statusOf(executionId)).toBe("judging");
  });

  it("terminalizes a wedged judging execution (persistent launch failure past the cutoff) as failed", async () => {
    const wedged = randomUUID();

    await db.insert(schema.evaluationExecutions).values({
      id: wedged,
      studyId,
      status: "judging",
      version: 4,
      startedAt: new Date(Date.now() - 15 * 60_000),
      // No judge attempts and a launch that always fails → the panel can never
      // reach allTerminal; without the backstop this retries forever.
    });

    const failingLaunch = stubDeps({
      launchPanel: async (executionId) => {
        if (executionId === wedged) {
          throw new Error("simulated persistent spawn failure");
        }
      },
    });

    const summary = await runEvaluationDispatchTick(failingLaunch, db);

    expect(summary.wedgedFailed).toBe(1);
    expect(await statusOf(wedged)).toBe("failed");

    const [row] = await db
      .select({ terminalReason: schema.evaluationExecutions.terminalReason })
      .from(schema.evaluationExecutions)
      .where(eq(schema.evaluationExecutions.id, wedged));

    expect(row.terminalReason).toBe("DISPATCH_STEP");

    const events = await readEvaluationEvents({ studyId }, db);
    const wedgedEvents = events.filter(
      (e) => e.executionId === wedged && e.eventType === "evaluation.failed",
    );

    expect(wedgedEvents).toHaveLength(1);
  });
});
