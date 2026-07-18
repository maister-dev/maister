import type {
  JudgeSpawnFn,
  JudgeTokenFn,
} from "@/lib/evaluations/judges/launch";
import type { TokenActor } from "@/lib/tokens/verify";

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { sealEvidenceSnapshot } from "@/lib/evaluations/evidence/snapshots";
import {
  getBoundObjectiveResults,
  getEvaluatorContext,
  listBoundEvidence,
  readBoundEvidenceItem,
  resolveBoundAttempt,
} from "@/lib/evaluations/judges/facade";
import {
  launchJudgePanel,
  provisionJudgeAttempts,
} from "@/lib/evaluations/judges/launch";
import { submitBoundJudgeResult } from "@/lib/evaluations/judges/seal";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof fullSchema>;
let projectId: string;
let studyId: string;
let methodRevisionId: string;

// A 2-criterion, 2-attempt panel (weighted_mean@1, quorum 2). correctness is
// weight-0.6, maintainability weight-0.4; both on a 0..5 scale.
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

function judgeActor(tokenId: string): TokenActor {
  return {
    tokenId,
    projectId,
    tokenKind: "agent",
    ownerUserId: null,
    agentId: "core:sdd-judge",
    actorLabel: "agent:core:sdd-judge",
    scopes: [
      "evaluations:context:read",
      "evaluations:evidence:read",
      "evaluations:objective:read",
      "evaluations:result:submit",
    ],
    boundRunId: null,
  };
}

async function seedExecution(
  status: string,
  opts: {
    snapshotId?: string;
    judgePolicySnapshot?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.evaluationExecutions).values({
    id,
    studyId,
    status,
    methodRevisionId,
    evidenceSnapshotId: opts.snapshotId ?? null,
    randomizationSeed: `seed-${id.slice(0, 8)}`,
    judgePolicySnapshot: opts.judgePolicySnapshot ?? null,
  });

  return id;
}

async function seedAttempt(
  executionId: string,
  ordinal: number,
  status: string,
): Promise<{ attemptId: string; tokenId: string }> {
  const attemptId = randomUUID();
  const tokenId = randomUUID();

  // Seed a live token row so seal-time revocation is observable.
  await db.insert(schema.projectTokens).values({
    id: tokenId,
    project_id: projectId,
    name: `agent-run:${randomUUID()}`,
    token_kind: "agent",
    agent_id: "core:sdd-judge",
    prefix: `mai_${tokenId.slice(0, 8)}`,
    token_hash: `hash-${tokenId}`,
    scopes: ["evaluations:result:submit"],
  });

  await db.insert(schema.evaluationJudgeAttempts).values({
    id: attemptId,
    executionId,
    role: "reviewer",
    ordinal,
    retryOrdinal: 0,
    agentId: "core:sdd-judge",
    tokenId,
    status,
  });

  return { attemptId, tokenId };
}

// The runs row a spawn adapter would create (mirrors the launch test's spawn
// stub); the seam contract requires the run to carry EXACTLY the caller's id.
async function insertAgentRun(runId: string): Promise<void> {
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    runKind: "agent",
    status: "Running",
    flowVersion: "agent",
    flowRevision: "agent",
    startedAt: new Date(),
  });
}

function scored(
  correctness: number,
  maintainability: number,
  confidence = 0.9,
) {
  return {
    criteria: [
      {
        criterionId: "correctness",
        state: "scored" as const,
        score: correctness,
        confidence,
      },
      {
        criterionId: "maintainability",
        state: "scored" as const,
        score: maintainability,
        confidence,
      },
    ],
  };
}

beforeAll(async () => {
  process.env.MAISTER_EVALUATION_EVIDENCE_ROOT = await mkdtemp(
    join(tmpdir(), "maister-eval-seam-"),
  );

  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_seam_test",
  });
  db = testDatabase.db;

  projectId = randomUUID();
  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  const flowId = randomUUID();

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

  const taskId = randomUUID();

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
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("evaluator facade + seal + aggregation seam (T4.1)", () => {
  it("refuses a token not bound to any live judge attempt", async () => {
    await expect(
      resolveBoundAttempt(judgeActor(randomUUID()), db),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses a token bound to a terminal attempt (late submit)", async () => {
    const executionId = await seedExecution("judging");
    const { tokenId } = await seedAttempt(executionId, 1, "completed");

    await expect(
      resolveBoundAttempt(judgeActor(tokenId), db),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("seals a valid result, writes criterion rows, revokes the token, and completes the panel on quorum", async () => {
    const executionId = await seedExecution("judging");
    const a1 = await seedAttempt(executionId, 1, "running");
    const a2 = await seedAttempt(executionId, 2, "running");

    const first = await submitBoundJudgeResult(
      judgeActor(a1.tokenId),
      scored(4, 4),
      db,
    );

    expect(first).toMatchObject({ valid: true, panelAdvanced: false });

    // criterion rows written for attempt 1.
    const crit = await db
      .select()
      .from(schema.evaluationCriterionResults)
      .where(eq(schema.evaluationCriterionResults.attemptId, a1.attemptId));

    expect(crit).toHaveLength(2);

    // token revoked at seal.
    const [tok] = await db
      .select({ revokedAt: schema.projectTokens.revoked_at })
      .from(schema.projectTokens)
      .where(eq(schema.projectTokens.id, a1.tokenId));

    expect(tok.revokedAt).not.toBeNull();

    // Second (quorum-completing) valid seal advances the panel to aggregation.
    const second = await submitBoundJudgeResult(
      judgeActor(a2.tokenId),
      scored(5, 5),
      db,
    );

    expect(second).toMatchObject({ valid: true, panelAdvanced: true });

    const [exec] = await db
      .select({ status: schema.evaluationExecutions.status })
      .from(schema.evaluationExecutions)
      .where(eq(schema.evaluationExecutions.id, executionId));

    expect(exec.status).toBe("completed");

    const agg = await db
      .select()
      .from(schema.evaluationAggregateResults)
      .where(eq(schema.evaluationAggregateResults.executionId, executionId));

    expect(agg).toHaveLength(1);
    expect(agg[0].algorithmId).toBe("weighted_mean");
  });

  it("seals an invalid result as a terminal-invalid attempt (never a silent zero)", async () => {
    const executionId = await seedExecution("judging");
    const a1 = await seedAttempt(executionId, 1, "running");

    // correctness 9 is out of the [0,5] scale — fail-closed INVALID.
    const outcome = await submitBoundJudgeResult(
      judgeActor(a1.tokenId),
      scored(9, 3),
      db,
    );

    expect(outcome.valid).toBe(false);
    if (!outcome.valid) {
      expect(outcome.violations.join(" ")).toContain("correctness");
    }

    const [attempt] = await db
      .select({
        status: schema.evaluationJudgeAttempts.status,
        reason: schema.evaluationJudgeAttempts.reason,
      })
      .from(schema.evaluationJudgeAttempts)
      .where(eq(schema.evaluationJudgeAttempts.id, a1.attemptId));

    expect(attempt.status).toBe("invalid");
    expect(attempt.reason).toBeTruthy();

    const crit = await db
      .select()
      .from(schema.evaluationCriterionResults)
      .where(eq(schema.evaluationCriterionResults.attemptId, a1.attemptId));

    expect(crit).toHaveLength(0);
  });

  it("routes a high-disagreement panel to review_required", async () => {
    const executionId = await seedExecution("judging");
    const a1 = await seedAttempt(executionId, 1, "running");
    const a2 = await seedAttempt(executionId, 2, "running");

    // correctness spread 5 - 1 = 4 (>= 2) → high disagreement → review.
    await submitBoundJudgeResult(judgeActor(a1.tokenId), scored(5, 5), db);
    await submitBoundJudgeResult(judgeActor(a2.tokenId), scored(1, 1), db);

    const [exec] = await db
      .select({ status: schema.evaluationExecutions.status })
      .from(schema.evaluationExecutions)
      .where(eq(schema.evaluationExecutions.id, executionId));

    expect(exec.status).toBe("review_required");

    const reviews = await db
      .select()
      .from(schema.evaluationReviews)
      .where(eq(schema.evaluationReviews.executionId, executionId));

    expect(reviews).toHaveLength(1);
    expect(reviews[0].status).toBe("required");
  });

  it("serves token-bound context, blinded evidence, and objective facts", async () => {
    const p1 = randomUUID();
    const p2 = randomUUID();

    await db.insert(schema.evaluationParticipants).values([
      {
        id: p1,
        studyId,
        sourceType: "observed",
        label: "Run 1",
        displayOrder: 0,
      },
      {
        id: p2,
        studyId,
        sourceType: "observed",
        label: "Run 2",
        displayOrder: 1,
      },
    ]);

    const sealed = await sealEvidenceSnapshot(
      {
        studyId,
        participantWatermarks: { [p1]: "w1", [p2]: "w2" },
        evidenceProtocolDigest: "epd",
        items: [
          {
            participantId: p1,
            kind: "diff",
            locator: "diff:p1",
            coverageClass: "captured",
            bytes: new TextEncoder().encode("hello candidate one"),
          },
          {
            participantId: p2,
            kind: "diff",
            locator: "diff:p2",
            coverageClass: "captured",
            bytes: new TextEncoder().encode("hello candidate two"),
          },
        ],
      },
      db,
    );

    const executionId = await seedExecution("judging", {
      snapshotId: sealed.snapshotId,
    });
    const { tokenId } = await seedAttempt(executionId, 1, "running");

    await db.insert(schema.evaluationObjectiveCheckRuns).values({
      executionId,
      participantId: p1,
      checkId: "gates",
      checkVersion: "1",
      status: "passed",
    });

    const actor = judgeActor(tokenId);

    const context = await getEvaluatorContext(actor, db);

    expect(context.attempt.role).toBe("reviewer");
    expect(context.method?.qualifiedId).toBe("core:sdd-quality");
    expect(context.candidates.sort()).toEqual(["Candidate A", "Candidate B"]);
    expect(context.evidence.itemCount).toBe(2);

    const page = await listBoundEvidence(actor, {}, db);

    expect(page.items).toHaveLength(2);
    // Real participant ids are NEVER exposed — only blind candidate labels.
    for (const item of page.items) {
      expect(item.candidate).toMatch(/^Candidate [AB]$/);
      expect(item.id).not.toBe(p1);
      expect(item).not.toHaveProperty("participantId");
    }

    const firstItem = page.items[0];
    const read = await readBoundEvidenceItem(
      actor,
      { itemId: firstItem.id },
      db,
    );

    expect(read.content).toContain("hello candidate");
    expect(read.truncated).toBe(false);

    const objective = await getBoundObjectiveResults(actor, db);

    expect(objective.checks).toHaveLength(1);
    expect(objective.checks[0].status).toBe("passed");
    expect(objective.checks[0].candidate).toMatch(/^Candidate [AB]$/);
  });

  it("provisions the attempt matrix idempotently and adopts on re-launch", async () => {
    const executionId = await seedExecution("judging", {
      judgePolicySnapshot: {
        roleBindings: [{ role: "reviewer", agentId: "core:sdd-judge" }],
      },
    });

    const first = await provisionJudgeAttempts(executionId, db);

    expect(first).toHaveLength(2); // reviewer × count 2

    // Idempotent: re-provision does not duplicate.
    const second = await provisionJudgeAttempts(executionId, db);

    expect(second).toHaveLength(2);

    let spawnCount = 0;
    const spawn = async () => {
      spawnCount++;
      const runId = randomUUID();

      await db.insert(schema.runs).values({
        id: runId,
        projectId,
        runKind: "agent",
        status: "Running",
        flowVersion: "agent",
        flowRevision: "agent",
        startedAt: new Date(),
      });

      return { runId, tokenId: randomUUID() };
    };

    const launched = await launchJudgePanel(executionId, { spawn }, db);

    expect(launched).toEqual({ launched: 2, adopted: 0 });
    expect(spawnCount).toBe(2);

    // Duplicate launch adopts already-launched attempts (no re-spawn).
    const relaunched = await launchJudgePanel(executionId, { spawn }, db);

    expect(relaunched).toEqual({ launched: 0, adopted: 2 });
    expect(spawnCount).toBe(2);
  });
});

describe("seal liveness CAS (reap-flip + double-submit protection)", () => {
  it("two-racer seal: exactly one completes, the other is a typed CONFLICT, one criterion row set", async () => {
    const executionId = await seedExecution("judging");
    const a1 = await seedAttempt(executionId, 1, "running");

    // A second live attempt keeps the panel below quorum so the race stays
    // inside the seal path (no aggregation advance in this test).
    await seedAttempt(executionId, 2, "running");

    const outcomes = await Promise.allSettled([
      submitBoundJudgeResult(judgeActor(a1.tokenId), scored(4, 4), db),
      submitBoundJudgeResult(judgeActor(a1.tokenId), scored(2, 2), db),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      (fulfilled[0] as PromiseFulfilledResult<unknown>).value,
    ).toMatchObject({ valid: true });
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
    });

    const [attempt] = await db
      .select({ status: schema.evaluationJudgeAttempts.status })
      .from(schema.evaluationJudgeAttempts)
      .where(eq(schema.evaluationJudgeAttempts.id, a1.attemptId));

    expect(attempt.status).toBe("completed");

    // Exactly ONE seal's worth of criterion rows (2 criteria) — never doubled.
    const crit = await db
      .select()
      .from(schema.evaluationCriterionResults)
      .where(eq(schema.evaluationCriterionResults.attemptId, a1.attemptId));

    expect(crit).toHaveLength(2);
  });

  it("reap-flip protection: sealing a timed_out attempt is a CONFLICT and never overwrites the reap", async () => {
    const executionId = await seedExecution("judging");
    const a1 = await seedAttempt(executionId, 1, "running");

    // The reaper flipped the attempt terminal before the (late) submit landed.
    await db
      .update(schema.evaluationJudgeAttempts)
      .set({ status: "timed_out", terminalAt: new Date(), reason: "timeout" })
      .where(eq(schema.evaluationJudgeAttempts.id, a1.attemptId));

    await expect(
      submitBoundJudgeResult(judgeActor(a1.tokenId), scored(4, 4), db),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const [after] = await db
      .select({
        status: schema.evaluationJudgeAttempts.status,
        reason: schema.evaluationJudgeAttempts.reason,
      })
      .from(schema.evaluationJudgeAttempts)
      .where(eq(schema.evaluationJudgeAttempts.id, a1.attemptId));

    expect(after.status).toBe("timed_out");
    expect(after.reason).toBe("timeout");

    const crit = await db
      .select()
      .from(schema.evaluationCriterionResults)
      .where(eq(schema.evaluationCriterionResults.attemptId, a1.attemptId));

    expect(crit).toHaveLength(0);
  });
});

describe("crash-safe judge launch (intent claim + adopt/re-spawn)", () => {
  const ROLE_BINDINGS = {
    roleBindings: [{ role: "reviewer", agentId: "core:sdd-judge" }],
  };

  it("records the launch intent before spawning and re-drives with the SAME run id", async () => {
    const executionId = await seedExecution("judging", {
      judgePolicySnapshot: ROLE_BINDINGS,
    });

    const failingSpawn: JudgeSpawnFn = async () => {
      throw new Error("simulated spawn crash");
    };

    await expect(
      launchJudgePanel(executionId, { spawn: failingSpawn }, db),
    ).rejects.toThrow(/simulated spawn crash/);

    // The crashed attempt kept its durable intent: intendedRunId + enqueuedAt
    // written by the CAS claim BEFORE the spawn side effect, status untouched.
    const attempts = await db
      .select()
      .from(schema.evaluationJudgeAttempts)
      .where(eq(schema.evaluationJudgeAttempts.executionId, executionId));
    const crashed = attempts.filter(
      (a: Record<string, unknown>) => a.intendedRunId !== null,
    );

    expect(crashed).toHaveLength(1);
    expect(crashed[0].status).toBe("queued");
    expect(crashed[0].agentRunId).toBeNull();
    expect(crashed[0].enqueuedAt).not.toBeNull();
    const intendedRunId = crashed[0].intendedRunId as string;

    const spawnCalls: Array<{ attemptId: string; runId: string }> = [];
    const spawn: JudgeSpawnFn = async (args) => {
      spawnCalls.push({ attemptId: args.attemptId, runId: args.runId });
      await insertAgentRun(args.runId);

      return { runId: args.runId, tokenId: randomUUID() };
    };

    const result = await launchJudgePanel(executionId, { spawn }, db);

    expect(result).toEqual({ launched: 2, adopted: 0 });

    // The re-spawn reused the SAME pre-recorded run id — never a fresh one.
    const respawn = spawnCalls.find((c) => c.attemptId === crashed[0].id);

    expect(respawn?.runId).toBe(intendedRunId);

    const [after] = await db
      .select()
      .from(schema.evaluationJudgeAttempts)
      .where(eq(schema.evaluationJudgeAttempts.id, crashed[0].id));

    expect(after.status).toBe("running");
    expect(after.agentRunId).toBe(intendedRunId);
  });

  it("adopts a crashed spawn's existing run without re-spawning (token minted via seam)", async () => {
    const executionId = await seedExecution("judging", {
      judgePolicySnapshot: ROLE_BINDINGS,
    });
    const attempts = await provisionJudgeAttempts(executionId, db);
    const target = attempts.find((a) => a.ordinal === 1)!;
    const intendedRunId = randomUUID();

    // Mimic spawn-then-crash: the intent was claimed AND the run got created,
    // but the bookkeeping (agentRunId/tokenId/running) never landed.
    await insertAgentRun(intendedRunId);
    await db
      .update(schema.evaluationJudgeAttempts)
      .set({ intendedRunId, enqueuedAt: new Date() })
      .where(eq(schema.evaluationJudgeAttempts.id, target.id));

    const spawnCalls: string[] = [];
    const spawn: JudgeSpawnFn = async (args) => {
      spawnCalls.push(args.attemptId);
      await insertAgentRun(args.runId);

      return { runId: args.runId, tokenId: randomUUID() };
    };
    const adoptedTokenId = randomUUID();
    const tokenCalls: Array<{
      agentId: string;
      projectId: string;
      runId: string;
    }> = [];
    const issueToken: JudgeTokenFn = async (args) => {
      tokenCalls.push(args);

      return { tokenId: adoptedTokenId };
    };

    const result = await launchJudgePanel(
      executionId,
      { spawn, issueToken },
      db,
    );

    expect(result).toEqual({ launched: 1, adopted: 1 });
    // spawn ran ONLY for the fresh sibling attempt — never for the adoption.
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls).not.toContain(target.id);
    expect(tokenCalls).toEqual([
      { agentId: "core:sdd-judge", projectId, runId: intendedRunId },
    ]);

    const [after] = await db
      .select()
      .from(schema.evaluationJudgeAttempts)
      .where(eq(schema.evaluationJudgeAttempts.id, target.id));

    expect(after.status).toBe("running");
    expect(after.agentRunId).toBe(intendedRunId);
    expect(after.tokenId).toBe(adoptedTokenId);
  });
});
