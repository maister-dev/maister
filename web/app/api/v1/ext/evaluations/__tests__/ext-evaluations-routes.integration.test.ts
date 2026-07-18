import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

let contextRoute: typeof import("../context/route");
let evidenceRoute: typeof import("../evidence/route");
let itemRoute: typeof import("../evidence/[itemId]/route");
let objectiveRoute: typeof import("../objective-results/route");
let resultRoute: typeof import("../result/route");

let issueJudgeAttemptToken: typeof import("@/lib/agents/tokens").issueJudgeAttemptToken;
let generateToken: typeof import("@/lib/tokens/secret").generateToken;
let sealEvidenceSnapshot: typeof import("@/lib/evaluations/evidence/snapshots").sealEvidenceSnapshot;

let projectId: string;
let studyId: string;
let methodRevisionId: string;
let snapshotId: string;
let participant1: string;
let participant2: string;

// Same 2-criterion weighted_mean rubric as judge-seam (quorum 2, so a single
// valid seal completes the attempt WITHOUT advancing the panel).
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

function extReq(
  path: string,
  init?: { method?: string; token?: string; body?: unknown; rawBody?: string },
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (init?.token) headers.authorization = `Bearer ${init.token}`;

  const body =
    init?.rawBody !== undefined
      ? init.rawBody
      : init?.body === undefined
        ? undefined
        : JSON.stringify(init.body);

  return new NextRequest(`http://localhost${path}`, {
    method: init?.method ?? "GET",
    headers,
    body,
  });
}

async function seedLiveAttempt(): Promise<{
  executionId: string;
  attemptId: string;
  tokenId: string;
  secret: string;
}> {
  const executionId = randomUUID();

  await db.insert(schema.evaluationExecutions).values({
    id: executionId,
    studyId,
    status: "judging",
    methodRevisionId,
    evidenceSnapshotId: snapshotId,
    randomizationSeed: `seed-${executionId.slice(0, 8)}`,
  });

  // A REAL judge token (verifyToken must accept the presented secret).
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
    },
    // The quorum-2 sibling stays running so a single seal never advances the
    // panel (mirrors the judge-seam contract).
    {
      id: randomUUID(),
      executionId,
      role: "reviewer",
      ordinal: 2,
      retryOrdinal: 0,
      agentId: "core:sdd-judge",
      status: "running",
    },
  ]);

  return {
    executionId,
    attemptId,
    tokenId: token.tokenId,
    secret: token.secret,
  };
}

const validSubmission = {
  criteria: [
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
  ],
};

beforeAll(async () => {
  process.env.MAISTER_EVALUATION_EVIDENCE_ROOT = await mkdtemp(
    join(tmpdir(), "maister-ext-eval-routes-"),
  );

  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_evaluations_routes_test",
  });
  db = testDatabase.db;

  contextRoute = await import("../context/route");
  evidenceRoute = await import("../evidence/route");
  itemRoute = await import("../evidence/[itemId]/route");
  objectiveRoute = await import("../objective-results/route");
  resultRoute = await import("../result/route");

  ({ issueJudgeAttemptToken } = await import("@/lib/agents/tokens"));
  ({ generateToken } = await import("@/lib/tokens/secret"));
  ({ sealEvidenceSnapshot } = await import(
    "@/lib/evaluations/evidence/snapshots"
  ));

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

  participant1 = randomUUID();
  participant2 = randomUUID();
  await db.insert(schema.evaluationParticipants).values([
    {
      id: participant1,
      studyId,
      sourceType: "observed",
      label: "Run 1",
      displayOrder: 0,
    },
    {
      id: participant2,
      studyId,
      sourceType: "observed",
      label: "Run 2",
      displayOrder: 1,
    },
  ]);

  const sealed = await sealEvidenceSnapshot(
    {
      studyId,
      participantWatermarks: { [participant1]: "w1", [participant2]: "w2" },
      evidenceProtocolDigest: "epd",
      items: [
        {
          participantId: participant1,
          kind: "diff",
          locator: "diff:p1",
          coverageClass: "captured",
          bytes: new TextEncoder().encode("hello candidate one"),
        },
        {
          participantId: participant2,
          kind: "diff",
          locator: "diff:p2",
          coverageClass: "captured",
          bytes: new TextEncoder().encode("hello candidate two"),
        },
      ],
    },
    db,
  );

  snapshotId = sealed.snapshotId;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

type RouteCall = [string, (token?: string) => Promise<Response>];

function allRouteCalls(itemId: string): RouteCall[] {
  return [
    [
      "context GET",
      (token) =>
        contextRoute.GET(extReq("/api/v1/ext/evaluations/context", { token })),
    ],
    [
      "evidence GET",
      (token) =>
        evidenceRoute.GET(
          extReq("/api/v1/ext/evaluations/evidence", { token }),
        ),
    ],
    [
      "evidence item GET",
      (token) =>
        itemRoute.GET(
          extReq(`/api/v1/ext/evaluations/evidence/${itemId}`, { token }),
          { params: Promise.resolve({ itemId }) },
        ),
    ],
    [
      "objective-results GET",
      (token) =>
        objectiveRoute.GET(
          extReq("/api/v1/ext/evaluations/objective-results", { token }),
        ),
    ],
    [
      "result POST",
      (token) =>
        resultRoute.POST(
          extReq("/api/v1/ext/evaluations/result", {
            method: "POST",
            token,
            body: validSubmission,
          }),
        ),
    ],
  ];
}

describe("ext evaluator routes (ADR-145 D10-D12)", () => {
  it("refuses every route without a bearer token (401 UNAUTHENTICATED)", async () => {
    for (const [label, call] of allRouteCalls(randomUUID())) {
      const res = await call(undefined);

      expect(res.status, label).toBe(401);
      expect(((await res.json()) as { code: string }).code, label).toBe(
        "UNAUTHENTICATED",
      );
    }
  });

  it("refuses a non-judge project token on every route (403 scope gate, no scope leak)", async () => {
    const { secret, prefix, hash } = generateToken();

    await db.insert(schema.projectTokens).values({
      id: randomUUID(),
      project_id: projectId,
      name: "ext-eval-non-judge",
      token_kind: "project",
      prefix,
      token_hash: hash,
      scopes: ["tasks:read"],
    });

    for (const [label, call] of allRouteCalls(randomUUID())) {
      const res = await call(secret);

      expect(res.status, label).toBe(403);
      const body = (await res.json()) as { code: string; message: string };

      expect(body.code, label).toBe("UNAUTHORIZED");
      // The refusal must never reveal which scopes the token holds.
      expect(body.message, label).toBe("insufficient scope");
    }
  });

  it("returns 401 (never 422) for a tokenless request with a malformed body — auth precedes body read", async () => {
    const res = await resultRoute.POST(
      extReq("/api/v1/ext/evaluations/result", {
        method: "POST",
        rawBody: "{not json at all",
      }),
    );

    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe(
      "UNAUTHENTICATED",
    );
  });

  it("rejects a result submission with extra body keys (422 CONFIG via .strict())", async () => {
    const { secret } = await seedLiveAttempt();

    const res = await resultRoute.POST(
      extReq("/api/v1/ext/evaluations/result", {
        method: "POST",
        token: secret,
        body: { ...validSubmission, attemptId: "smuggled" },
      }),
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("CONFIG");
  });

  it("maps non-numeric evidence query params to 422 CONFIG, never 500", async () => {
    const { secret } = await seedLiveAttempt();

    const badLimit = await evidenceRoute.GET(
      extReq("/api/v1/ext/evaluations/evidence?limit=abc", { token: secret }),
    );

    expect(badLimit.status).toBe(422);
    expect(((await badLimit.json()) as { code: string }).code).toBe("CONFIG");

    const page = await evidenceRoute.GET(
      extReq("/api/v1/ext/evaluations/evidence", { token: secret }),
    );
    const itemId = ((await page.json()) as { items: Array<{ id: string }> })
      .items[0].id;

    for (const query of ["offset=abc", "length=abc"]) {
      const res = await itemRoute.GET(
        extReq(`/api/v1/ext/evaluations/evidence/${itemId}?${query}`, {
          token: secret,
        }),
        { params: Promise.resolve({ itemId }) },
      );

      expect(res.status, query).toBe(422);
      expect(((await res.json()) as { code: string }).code, query).toBe(
        "CONFIG",
      );
    }
  });

  it("serves the full judge flow: context, paged blinded evidence, bounded window, objective facts, then one sealed result", async () => {
    const { executionId, attemptId, tokenId, secret } = await seedLiveAttempt();

    await db.insert(schema.evaluationObjectiveCheckRuns).values({
      executionId,
      participantId: participant1,
      checkId: "gates",
      checkVersion: "1",
      status: "passed",
    });

    // 1. Context — server-derived, blinded, no real participant ids.
    const contextRes = await contextRoute.GET(
      extReq("/api/v1/ext/evaluations/context", { token: secret }),
    );

    expect(contextRes.status).toBe(200);
    const context = (await contextRes.json()) as {
      attempt: { id: string; role: string };
      method: { qualifiedId: string } | null;
      candidates: string[];
      evidence: { itemCount: number };
    };

    expect(context.attempt.id).toBe(attemptId);
    expect(context.attempt.role).toBe("reviewer");
    expect(context.method?.qualifiedId).toBe("core:sdd-quality");
    expect([...context.candidates].sort()).toEqual([
      "Candidate A",
      "Candidate B",
    ]);
    expect(context.evidence.itemCount).toBe(2);

    // 2. Evidence listing — cursor pagination, blinded candidates only.
    const firstPageRes = await evidenceRoute.GET(
      extReq("/api/v1/ext/evaluations/evidence?limit=1", { token: secret }),
    );

    expect(firstPageRes.status).toBe(200);
    const firstPage = (await firstPageRes.json()) as {
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };

    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPageRes = await evidenceRoute.GET(
      extReq(
        `/api/v1/ext/evaluations/evidence?limit=1&cursor=${firstPage.nextCursor}`,
        { token: secret },
      ),
    );
    const secondPage = (await secondPageRes.json()) as {
      items: Array<Record<string, unknown>>;
    };

    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0].id).not.toBe(firstPage.items[0].id);

    for (const item of [...firstPage.items, ...secondPage.items]) {
      expect(item.candidate).toMatch(/^Candidate [AB]$/);
      expect(item.id).not.toBe(participant1);
      expect(item.id).not.toBe(participant2);
      expect(item).not.toHaveProperty("participantId");
      expect(item).not.toHaveProperty("locator");
      expect(item).not.toHaveProperty("blobKey");
    }

    // 3. Bounded evidence window read.
    const itemId = firstPage.items[0].id as string;
    const windowRes = await itemRoute.GET(
      extReq(`/api/v1/ext/evaluations/evidence/${itemId}?offset=6&length=9`, {
        token: secret,
      }),
      { params: Promise.resolve({ itemId }) },
    );

    expect(windowRes.status).toBe(200);
    const window = (await windowRes.json()) as {
      itemId: string;
      content: string;
      offset: number;
    };

    expect(window.itemId).toBe(itemId);
    expect(window.offset).toBe(6);
    expect(window.content).toBe("candidate");

    // 4. Objective facts — blinded, status + reason verbatim.
    const objectiveRes = await objectiveRoute.GET(
      extReq("/api/v1/ext/evaluations/objective-results", { token: secret }),
    );

    expect(objectiveRes.status).toBe(200);
    const objective = (await objectiveRes.json()) as {
      checks: Array<{ candidate: string | null; status: string }>;
    };

    expect(objective.checks).toHaveLength(1);
    expect(objective.checks[0].status).toBe("passed");
    expect(objective.checks[0].candidate).toMatch(/^Candidate [AB]$/);

    // 5. Result submit — sealed, attempt terminal, token revoked.
    const submitRes = await resultRoute.POST(
      extReq("/api/v1/ext/evaluations/result", {
        method: "POST",
        token: secret,
        body: validSubmission,
      }),
    );

    expect(submitRes.status).toBe(200);
    expect(await submitRes.json()).toMatchObject({
      valid: true,
      panelAdvanced: false,
    });

    const [attempt] = await db
      .select({ status: schema.evaluationJudgeAttempts.status })
      .from(schema.evaluationJudgeAttempts)
      .where(eq(schema.evaluationJudgeAttempts.id, attemptId));

    expect(attempt.status).toBe("completed");

    const [token] = await db
      .select({ revokedAt: schema.projectTokens.revoked_at })
      .from(schema.projectTokens)
      .where(eq(schema.projectTokens.id, tokenId));

    expect(token.revokedAt).not.toBeNull();

    // The revoked token is dead for every subsequent call (401).
    const afterSeal = await contextRoute.GET(
      extReq("/api/v1/ext/evaluations/context", { token: secret }),
    );

    expect(afterSeal.status).toBe(401);
  });
});
