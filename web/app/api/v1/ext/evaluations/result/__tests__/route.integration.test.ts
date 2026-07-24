import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof fullSchema>;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let resultRoute: typeof import("../route");
let issueJudgeAttemptToken: typeof import("@/lib/agents/tokens").issueJudgeAttemptToken;

let projectId: string;
let studyId: string;
let scalarMethodRevisionId: string;
let pairwiseMethodRevisionId: string;
let participantA: string;
let participantB: string;

// A NON-pairwise (scalar) method: 2-criterion weighted_mean, quorum 2 — matches
// the ext-routes harness so a scalar attempt scores the rubric with NO winner.
const SCALAR_DEFINITION = {
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

// A pairwise method: 1 criterion "overall" (methods always carry ≥1), one judge
// role at count 2, per-match quorum 2 (mirrors pairwise-execution's fixture).
const PAIRWISE_DEFINITION = {
  definition: {
    id: "head-to-head",
    modes: ["pairwise"],
    criteria: [
      { id: "overall", weight: 1, scale: { min: 0, max: 5 }, optional: false },
    ],
    judges: { roles: [{ id: "reviewer", count: 2 }] },
    aggregation: { algorithm: "pairwise_tournament@1" },
    panelPolicy: { quorum: 2 },
    caps: {},
    objectiveChecks: [],
  },
  criteria: [{ id: "overall", normalizedWeight: 1 }],
};

function extReq(
  path: string,
  init?: { method?: string; token?: string; body?: unknown },
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (init?.token) headers.authorization = `Bearer ${init.token}`;

  const body = init?.body === undefined ? undefined : JSON.stringify(init.body);

  return new NextRequest(`http://localhost${path}`, {
    method: init?.method ?? "GET",
    headers,
    body,
  });
}

async function submitResult(secret: string, body: unknown): Promise<Response> {
  return resultRoute.POST(
    extReq("/api/v1/ext/evaluations/result", {
      method: "POST",
      token: secret,
      body,
    }),
  );
}

async function seedExecution(methodRevisionId: string): Promise<string> {
  const executionId = randomUUID();

  await db.insert(schema.evaluationExecutions).values({
    id: executionId,
    studyId,
    status: "judging",
    methodRevisionId,
    randomizationSeed: `seed-${executionId.slice(0, 8)}`,
  });

  return executionId;
}

// A live PAIRWISE attempt bound to a fresh judge token, PLUS a quorum-2 sibling
// that stays `running` so a single seal never advances the panel (a run of the
// aggregation would flip `panelAdvanced`). match_a/match_b carry the pair
// identity — non-null ⇒ this attempt submits a head-to-head pick.
async function seedPairwiseAttempt(): Promise<{
  attemptId: string;
  secret: string;
}> {
  const executionId = await seedExecution(pairwiseMethodRevisionId);
  const token = await issueJudgeAttemptToken({
    agentId: "core:sdd-judge",
    projectId,
    runId: randomUUID(),
    db,
  });
  const attemptId = randomUUID();

  await db.insert(schema.evaluationJudgeAttempts).values([
    {
      id: attemptId,
      executionId,
      role: "reviewer",
      ordinal: 1,
      retryOrdinal: 0,
      agentId: "core:sdd-judge",
      tokenId: token.tokenId,
      status: "running",
      matchA: participantA,
      matchB: participantB,
    },
    {
      id: randomUUID(),
      executionId,
      role: "reviewer",
      ordinal: 2,
      retryOrdinal: 0,
      agentId: "core:sdd-judge",
      status: "running",
      matchA: participantA,
      matchB: participantB,
    },
  ]);

  return { attemptId, secret: token.secret };
}

// A live NON-pairwise (scalar) attempt: match_a/match_b are NULL, so the frozen
// contract must refuse ANY `winner` payload (fail-closed).
async function seedScalarAttempt(): Promise<{
  attemptId: string;
  secret: string;
}> {
  const executionId = await seedExecution(scalarMethodRevisionId);
  const token = await issueJudgeAttemptToken({
    agentId: "core:sdd-judge",
    projectId,
    runId: randomUUID(),
    db,
  });
  const attemptId = randomUUID();

  await db.insert(schema.evaluationJudgeAttempts).values({
    id: attemptId,
    executionId,
    role: "reviewer",
    ordinal: 1,
    retryOrdinal: 0,
    agentId: "core:sdd-judge",
    tokenId: token.tokenId,
    status: "running",
    matchA: null,
    matchB: null,
  });

  return { attemptId, secret: token.secret };
}

async function attemptRow(
  attemptId: string,
): Promise<{ status: string; sealedResult: { winner?: string } | null }> {
  const [row] = await db
    .select({
      status: schema.evaluationJudgeAttempts.status,
      sealedResult: schema.evaluationJudgeAttempts.sealedResult,
    })
    .from(schema.evaluationJudgeAttempts)
    .where(eq(schema.evaluationJudgeAttempts.id, attemptId));

  return row as { status: string; sealedResult: { winner?: string } | null };
}

// The rubric cell every pairwise submission must ALSO carry — `criteria` is
// scored for a pairwise attempt too; `winner` is the additional head-to-head pick.
const PAIRWISE_CRITERIA = [
  {
    criterionId: "overall",
    state: "scored" as const,
    score: 5,
    confidence: 0.9,
  },
];
const SCALAR_CRITERIA = [
  {
    criterionId: "correctness",
    state: "scored" as const,
    score: 4,
    confidence: 0.9,
  },
  {
    criterionId: "maintainability",
    state: "scored" as const,
    score: 3,
    confidence: 0.9,
  },
];

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_eval_result_pairwise_test",
  });
  db = testDatabase.db;

  resultRoute = await import("../route");
  ({ issueJudgeAttemptToken } = await import("@/lib/agents/tokens"));

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

  scalarMethodRevisionId = randomUUID();
  pairwiseMethodRevisionId = randomUUID();
  await db.insert(schema.evaluationMethodRevisions).values([
    {
      id: scalarMethodRevisionId,
      packageInstallId: installId,
      methodId: "sdd-quality",
      qualifiedId: "core:sdd-quality",
      packageName: "core",
      versionLabel: "v1.1.0",
      schemaVersion: 1,
      normalizedDefinition: SCALAR_DEFINITION,
      definitionDigest: "dd-scalar",
      promptDigest: "pd",
      schemaDigest: "sd",
      compat: { engineMin: "3.2.0" },
      activation: "enabled",
    },
    {
      id: pairwiseMethodRevisionId,
      packageInstallId: installId,
      methodId: "head-to-head",
      qualifiedId: "core:head-to-head",
      packageName: "core",
      versionLabel: "v1.1.0",
      schemaVersion: 1,
      normalizedDefinition: PAIRWISE_DEFINITION,
      definitionDigest: "dd-pairwise",
      promptDigest: "pd",
      schemaDigest: "sd",
      compat: { engineMin: "3.2.0" },
      activation: "enabled",
    },
  ]);

  participantA = randomUUID();
  participantB = randomUUID();
  await db.insert(schema.evaluationParticipants).values([
    {
      id: participantA,
      studyId,
      sourceType: "observed",
      label: "Run 1",
      displayOrder: 0,
    },
    {
      id: participantB,
      studyId,
      sourceType: "observed",
      label: "Run 2",
      displayOrder: 1,
    },
  ]);
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("ext evaluation result — pairwise pick semantics (ADR-150)", () => {
  it("seals a pairwise pick of winner:a for a valid (match_a, match_b) and persists it", async () => {
    const { attemptId, secret } = await seedPairwiseAttempt();

    const res = await submitResult(secret, {
      winner: "a",
      criteria: PAIRWISE_CRITERIA,
    });

    expect(res.status).toBe(200);
    // The sibling attempt stays running, so the single seal never advances the panel.
    expect(await res.json()).toMatchObject({
      valid: true,
      attemptId,
      panelAdvanced: false,
    });

    const row = await attemptRow(attemptId);

    expect(row.status).toBe("completed");
    expect(row.sealedResult?.winner).toBe("a");
  });

  it("records a pairwise tie (winner:tie) as a sealed, completed pick", async () => {
    const { attemptId, secret } = await seedPairwiseAttempt();

    const res = await submitResult(secret, {
      winner: "tie",
      criteria: PAIRWISE_CRITERIA,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      valid: true,
      panelAdvanced: false,
    });

    const row = await attemptRow(attemptId);

    expect(row.status).toBe("completed");
    expect(row.sealedResult?.winner).toBe("tie");
  });

  it("refuses a pairwise winner on a NON-pairwise attempt (422 CONFIG), attempt preserved", async () => {
    const { attemptId, secret } = await seedScalarAttempt();

    const res = await submitResult(secret, {
      winner: "a",
      criteria: SCALAR_CRITERIA,
    });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("CONFIG");

    // The seal throws on the match-identity gate BEFORE terminalizing — the
    // attempt stays live, never a silent seal.
    const row = await attemptRow(attemptId);

    expect(row.status).toBe("running");
    expect(row.sealedResult).toBeNull();
  });

  it("refuses a pairwise attempt submitted with NO winner (422 CONFIG), attempt preserved", async () => {
    const { attemptId, secret } = await seedPairwiseAttempt();

    const res = await submitResult(secret, { criteria: PAIRWISE_CRITERIA });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("CONFIG");

    const row = await attemptRow(attemptId);

    expect(row.status).toBe("running");
    expect(row.sealedResult).toBeNull();
  });
});
