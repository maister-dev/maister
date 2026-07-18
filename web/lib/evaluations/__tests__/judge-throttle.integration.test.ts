import type { JudgeSpawnFn } from "@/lib/evaluations/judges/launch";
import type { TokenActor } from "@/lib/tokens/verify";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { launchJudgePanel } from "@/lib/evaluations/judges/launch";
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

// Same 2-criterion, 2-attempt panel shape as the judge-seam suite.
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

const ROLE_BINDINGS = [{ role: "reviewer", agentId: "core:sdd-judge" }];

// The start-time frozen criterion specs matching NORMALIZED_DEFINITION.
const SNAPSHOT_CRITERIA = [
  {
    id: "correctness",
    weight: 0.6,
    normalizedWeight: 0.6,
    scaleMin: 0,
    scaleMax: 5,
    optional: false,
    itemCap: null,
  },
  {
    id: "maintainability",
    weight: 0.4,
    normalizedWeight: 0.4,
    scaleMin: 0,
    scaleMax: 5,
    optional: false,
    itemCap: null,
  },
];

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

async function seedExecution(opts: {
  judgePolicySnapshot?: Record<string, unknown>;
  aggregationPolicySnapshot?: Record<string, unknown>;
}): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.evaluationExecutions).values({
    id,
    studyId,
    status: "judging",
    methodRevisionId,
    randomizationSeed: `seed-${id.slice(0, 8)}`,
    judgePolicySnapshot: opts.judgePolicySnapshot ?? null,
    aggregationPolicySnapshot: opts.aggregationPolicySnapshot ?? null,
  });

  return id;
}

async function seedAttempt(
  executionId: string,
  ordinal: number,
): Promise<{ attemptId: string; tokenId: string }> {
  const attemptId = randomUUID();
  const tokenId = randomUUID();

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
    status: "running",
    runningAt: new Date(),
  });

  return { attemptId, tokenId };
}

function makeSpawn(runStatus: "Running" | "Pending"): {
  spawn: JudgeSpawnFn;
  calls: string[];
} {
  const calls: string[] = [];
  const spawn: JudgeSpawnFn = async (args) => {
    calls.push(args.attemptId);
    await db.insert(schema.runs).values({
      id: args.runId,
      projectId,
      runKind: "agent",
      status: runStatus,
      flowVersion: "agent",
      flowRevision: "agent",
      startedAt: new Date(),
    });

    return { runId: args.runId, tokenId: randomUUID(), runStatus };
  };

  return { spawn, calls };
}

async function attemptsOf(executionId: string) {
  return db
    .select({
      id: schema.evaluationJudgeAttempts.id,
      status: schema.evaluationJudgeAttempts.status,
      agentRunId: schema.evaluationJudgeAttempts.agentRunId,
      runningAt: schema.evaluationJudgeAttempts.runningAt,
    })
    .from(schema.evaluationJudgeAttempts)
    .where(eq(schema.evaluationJudgeAttempts.executionId, executionId));
}

function scored(correctness: number, maintainability: number) {
  return {
    criteria: [
      {
        criterionId: "correctness",
        state: "scored" as const,
        score: correctness,
        confidence: 0.9,
      },
      {
        criterionId: "maintainability",
        state: "scored" as const,
        score: maintainability,
        confidence: 0.9,
      },
    ],
  };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_throttle_test",
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

describe("judge panel launch throttling (maxParallelAttempts)", () => {
  it("spawns exactly k of N attempts on the first pass and continues on later passes", async () => {
    const executionId = await seedExecution({
      judgePolicySnapshot: {
        roleBindings: ROLE_BINDINGS,
        policy: { maxParallelAttempts: 1 },
      },
    });
    const { spawn, calls } = makeSpawn("Running");

    const first = await launchJudgePanel(executionId, { spawn }, db);

    expect(first).toEqual({ launched: 1, adopted: 0 });
    expect(calls).toHaveLength(1);

    let rows = await attemptsOf(executionId);

    expect(rows.filter((r) => r.agentRunId !== null)).toHaveLength(1);
    expect(rows.filter((r) => r.status === "queued")).toHaveLength(1);

    // A second pass while the first attempt is still live spawns nothing.
    const second = await launchJudgePanel(executionId, { spawn }, db);

    expect(second).toEqual({ launched: 0, adopted: 1 });
    expect(calls).toHaveLength(1);

    // Terminalize the live attempt — the freed slot lets the next pass spawn.
    const live = rows.find((r) => r.agentRunId !== null)!;

    await db
      .update(schema.evaluationJudgeAttempts)
      .set({ status: "completed", terminalAt: new Date() })
      .where(eq(schema.evaluationJudgeAttempts.id, live.id));

    const third = await launchJudgePanel(executionId, { spawn }, db);

    expect(third).toEqual({ launched: 1, adopted: 1 });
    expect(calls).toHaveLength(2);

    rows = await attemptsOf(executionId);
    expect(rows.filter((r) => r.agentRunId !== null)).toHaveLength(2);
  });
});

describe("Pending-run spawn (runningAt anchors at Running, never at enqueue)", () => {
  it("records the run link but leaves runningAt null for a cap-queued run, then promotes once Running", async () => {
    const executionId = await seedExecution({
      judgePolicySnapshot: { roleBindings: ROLE_BINDINGS },
    });
    const { spawn } = makeSpawn("Pending");

    const first = await launchJudgePanel(executionId, { spawn }, db);

    expect(first).toEqual({ launched: 2, adopted: 0 });

    let rows = await attemptsOf(executionId);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.agentRunId).not.toBeNull();
      expect(row.status).toBe("queued");
      expect(row.runningAt).toBeNull();
    }

    // The agent scheduler promotes ONE run to Running; the next pass stamps
    // exactly that attempt's timeout anchor.
    const promoted = rows[0];

    await db
      .update(schema.runs)
      .set({ status: "Running" })
      .where(eq(schema.runs.id, promoted.agentRunId!));

    const second = await launchJudgePanel(executionId, { spawn }, db);

    expect(second).toEqual({ launched: 0, adopted: 2 });

    rows = await attemptsOf(executionId);
    const after = new Map(rows.map((r) => [r.id, r]));

    expect(after.get(promoted.id)?.status).toBe("running");
    expect(after.get(promoted.id)?.runningAt).not.toBeNull();

    const still = rows.find((r) => r.id !== promoted.id)!;

    expect(still.status).toBe("queued");
    expect(still.runningAt).toBeNull();
  });
});

describe("start-time snapshot immutability (seal + aggregate ignore live method drift)", () => {
  it("uses the execution's frozen criteria/algorithm/quorum after the method projection row is mutated", async () => {
    const executionId = await seedExecution({
      judgePolicySnapshot: {
        roleBindings: ROLE_BINDINGS,
        policy: { quorum: 2, randomizeOrder: true },
        criteria: SNAPSHOT_CRITERIA,
      },
      aggregationPolicySnapshot: {
        algorithm: "weighted_mean@1",
        quorum: 2,
        totalMax: null,
        gateCheckIds: [],
        definitionDigest: "dd",
        schemaDigest: "sd",
      },
    });
    const a1 = await seedAttempt(executionId, 1);
    const a2 = await seedAttempt(executionId, 2);

    // The registry upserts the projection IN PLACE mid-execution: the drifted
    // definition narrows the scale to 0..3, drops quorum to 1, and swaps the
    // algorithm — a live re-read would reject the scores below and aggregate
    // with the wrong algorithm.
    await db
      .update(schema.evaluationMethodRevisions)
      .set({
        normalizedDefinition: {
          definition: {
            id: "sdd-quality",
            criteria: [
              {
                id: "correctness",
                weight: 1,
                scale: { min: 0, max: 3 },
                optional: false,
              },
            ],
            judges: { roles: [{ id: "reviewer", count: 1 }] },
            aggregation: { algorithm: "median@1" },
            panelPolicy: { quorum: 1 },
            caps: {},
            objectiveChecks: [],
          },
          criteria: [{ id: "correctness", normalizedWeight: 1 }],
        },
        definitionDigest: "dd-DRIFTED",
        schemaDigest: "sd-DRIFTED",
      })
      .where(eq(schema.evaluationMethodRevisions.id, methodRevisionId));

    // Scores 4/5 are valid under the frozen 0..5 scale, invalid under the
    // drifted 0..3 one — a live re-read would seal these INVALID.
    const first = await submitBoundJudgeResult(
      judgeActor(a1.tokenId),
      scored(4, 4),
      db,
    );

    expect(first).toMatchObject({ valid: true, panelAdvanced: false });

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

    const [agg] = await db
      .select()
      .from(schema.evaluationAggregateResults)
      .where(eq(schema.evaluationAggregateResults.executionId, executionId));

    // Frozen algorithm + quorum + digests, not the drifted ones.
    expect(agg.algorithmId).toBe("weighted_mean");
    expect(agg.quorum).toMatchObject({ quorum: 2, quorumMet: true });
    expect(agg.inputs).toMatchObject({
      methodDefinitionDigest: "dd",
      methodSchemaDigest: "sd",
    });
  });
});
