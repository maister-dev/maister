import type { RunnerCatalogEntry } from "@/lib/acp-runners/resolve";
import type {
  PreflightFlowRevision,
  PreflightMethodRequirements,
  PreflightOverlayCatalog,
} from "@/lib/evaluations/preflight";
import type { PreflightContractLoaders } from "@/lib/evaluations/recipes";

import { randomUUID } from "node:crypto";

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

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// The route uses the LIVE preflight loaders; stub them so the route CONTRACT
// (auth / ownership / eligibility→DTO / round-trip / 409) is exercised without
// the flow-projection stack (covered by the T1.1 preflight-loaders tests).
function liveFlow(): PreflightFlowRevision {
  return {
    flowRefId: "bugfix",
    flowRevisionId: "rev-1",
    projectId,
    trusted: true,
    enablementLaunchable: true,
    engineCompatible: true,
    schemaVersionSupported: true,
    requiredTaskFields: ["title"],
    formRequiredFields: ["title"],
    formKnownFields: ["title"],
    producedArtifactKinds: ["diff"],
    slotKeys: ["session:main"],
    requiredSlotKeys: [],
  };
}

const runner: RunnerCatalogEntry = {
  id: "r1",
  adapter: "claude",
  capabilityAgent: "claude",
  model: "claude-sonnet-4-6",
  providerKind: "anthropic",
  permissionPolicy: "default",
  enabled: true,
  ready: true,
};

function stubLoaders(): PreflightContractLoaders {
  const overlay: PreflightOverlayCatalog = {
    rules: new Set(),
    skills: new Set(),
    mcps: new Set(),
    subagents: new Set(),
  };
  const method: PreflightMethodRequirements = {
    qualifiedId: "core:sdd-quality",
    requiredArtifactKinds: ["diff"],
  };

  return {
    loadFlowRevision: async () => liveFlow(),
    loadMethodRequirements: async () => method,
    loadRunnerCatalog: async () => [runner],
    loadOverlayCatalog: async () => overlay,
  };
}

vi.mock("@/lib/evaluations/preflight-loaders", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/evaluations/preflight-loaders")
    >();

  return { ...actual, livePreflightLoaders: () => stubLoaders() };
});

let currentRoute: typeof import("../standardization/route");
let rollbackRoute: typeof import("../standardization/rollback/route");
let eligibilityRoute: typeof import("../studies/[studyId]/standardization-eligibility/route");
let standardizeRoute: typeof import("../studies/[studyId]/standardize/route");

let recipeHelpers: typeof import("@/lib/evaluations/recipes");
let studyHelpers: typeof import("@/lib/evaluations/studies");
let recipeContract: typeof import("@/lib/evaluations/recipe");

let projectId: string;
let slug: string;
let flowId: string;
let taskId: string;
let adminId: string;
let viewerId: string;

function recipeDefinition(titleMarker = "x"): Record<string, unknown> {
  const flow = liveFlow();

  return {
    schemaVersion: 1,
    flow: {
      flowRefId: flow.flowRefId,
      flowRevisionId: flow.flowRevisionId,
      inputContractDigest: recipeContract.computeInputContractDigest(flow),
      artifactContractDigest:
        recipeContract.computeArtifactContractDigest(flow),
    },
    inputs: { taskSnapshotRef: "snap", formValues: { title: titleMarker } },
    executionPolicy: { preset: "supervised" },
    slotBindings: { "session:main": { mode: "runner", runnerId: "r1" } },
  };
}

async function decidedStudyWithLaunchedWinner(
  titleMarker = "x",
): Promise<string> {
  const study = await studyHelpers.createStudy(
    { projectId, taskId, title: `S-${randomUUID().slice(0, 6)}` },
    db,
  );
  const recipe = await recipeHelpers.createControlledRecipe(
    {
      studyId: study.id as string,
      projectId,
      key: "winner",
      label: "Winner",
      definition: recipeDefinition(titleMarker),
    },
    db,
  );
  const participantId = randomUUID();

  await db.insert(schema.evaluationParticipants).values({
    id: participantId,
    studyId: study.id as string,
    sourceType: "launched",
    recipeId: recipe.id as string,
    label: "Winner #1",
    replicateOrdinal: 1,
    launchReason: "initial",
  });
  await db.insert(schema.evaluationHumanVerdicts).values({
    studyId: study.id as string,
    outcome: "winner",
    participantIds: [participantId],
    executionIds: [],
    noEvaluationEvidenceAck: true,
  });

  return study.id as string;
}

function asAdmin(): void {
  sessionRef.value = { user: { id: adminId } };
}

function asViewer(): void {
  sessionRef.value = { user: { id: viewerId } };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_standardization_routes_test",
  });
  db = testDatabase.db;

  currentRoute = await import("../standardization/route");
  rollbackRoute = await import("../standardization/rollback/route");
  eligibilityRoute = await import(
    "../studies/[studyId]/standardization-eligibility/route"
  );
  standardizeRoute = await import("../studies/[studyId]/standardize/route");
  recipeHelpers = await import("@/lib/evaluations/recipes");
  studyHelpers = await import("@/lib/evaluations/studies");
  recipeContract = await import("@/lib/evaluations/recipe");

  projectId = randomUUID();
  slug = `proj-${projectId.slice(0, 8)}`;
  flowId = randomUUID();
  adminId = randomUUID();
  viewerId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: "proj",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db.insert(schema.users).values([
    {
      id: adminId,
      email: `a-${adminId.slice(0, 8)}@x.io`,
      role: "admin",
      accountStatus: "active",
    },
    {
      id: viewerId,
      email: `v-${viewerId.slice(0, 8)}@x.io`,
      role: "viewer",
      accountStatus: "active",
    },
  ]);
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
  const id = randomUUID();

  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id,
    projectId,
    title: "T",
    prompt: "p",
    flowId,
  });
  taskId = id;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

function studyParams(studyId: string): {
  params: Promise<{ slug: string; studyId: string }>;
} {
  return { params: Promise.resolve({ slug, studyId }) };
}

function slugParams(): { params: Promise<{ slug: string }> } {
  return { params: Promise.resolve({ slug }) };
}

describe("standardization routes", () => {
  it("403s a viewer on every standardization route (RBAC)", async () => {
    asViewer();
    const studyId = await decidedStudyWithLaunchedWinner();

    const eligibility = await eligibilityRoute.GET(
      new NextRequest("http://t/e"),
      studyParams(studyId),
    );

    expect(eligibility.status).toBe(403);

    const standardize = await standardizeRoute.POST(
      new NextRequest("http://t/s", { method: "POST" }),
      studyParams(studyId),
    );

    expect(standardize.status).toBe(403);

    const current = await currentRoute.GET(
      new NextRequest("http://t/c"),
      slugParams(),
    );

    expect(current.status).toBe(403);
  });

  it("previews eligibility (eligible winner + a refusal case)", async () => {
    asAdmin();
    const studyId = await decidedStudyWithLaunchedWinner();

    const ok = await eligibilityRoute.GET(
      new NextRequest("http://t/e"),
      studyParams(studyId),
    );

    expect(ok.status).toBe(200);
    const okBody = await ok.json();

    expect(okBody.eligible).toBe(true);
    expect(okBody.refusals).toEqual([]);
    // The winning recipe body is NOT surfaced in the preview DTO.
    expect(okBody.recipeDefinition).toBeUndefined();

    const bare = await studyHelpers.createStudy(
      { projectId, taskId, title: "NoWinner" },
      db,
    );
    const refused = await eligibilityRoute.GET(
      new NextRequest("http://t/e"),
      studyParams(bare.id as string),
    );
    const refusedBody = await refused.json();

    expect(refusedBody.eligible).toBe(false);
    expect(refusedBody.refusals).toContain("no_conclusive_winner");
  });

  it("standardizes, reads current, and rolls back (round-trip)", async () => {
    asAdmin();
    const slot = `rt-${randomUUID().slice(0, 6)}`;
    const a = await decidedStudyWithLaunchedWinner("round-trip-one");
    const b = await decidedStudyWithLaunchedWinner("round-trip-two");

    const first = await standardizeRoute.POST(
      new NextRequest("http://t/s", {
        method: "POST",
        body: JSON.stringify({ slot }),
      }),
      studyParams(a),
    );

    expect(first.status).toBe(201);
    expect((await first.json()).revision).toBe(1);

    await standardizeRoute.POST(
      new NextRequest("http://t/s", {
        method: "POST",
        body: JSON.stringify({ slot }),
      }),
      studyParams(b),
    );

    const current = await currentRoute.GET(
      new NextRequest(`http://t/c?slot=${slot}`),
      slugParams(),
    );
    const currentBody = await current.json();

    expect(currentBody.current.revision).toBe(2);

    const rolled = await rollbackRoute.POST(
      new NextRequest("http://t/r", {
        method: "POST",
        body: JSON.stringify({ slot }),
      }),
      slugParams(),
    );

    expect(rolled.status).toBe(201);
    const rolledBody = await rolled.json();

    expect(rolledBody.action).toBe("rollback");
    expect(rolledBody.rolledBackToRevision).toBe(1);
  });

  it("409s standardizing an ineligible study (drift re-check inside the write)", async () => {
    asAdmin();
    const bare = await studyHelpers.createStudy(
      { projectId, taskId, title: "Ineligible" },
      db,
    );

    const res = await standardizeRoute.POST(
      new NextRequest("http://t/s", { method: "POST" }),
      studyParams(bare.id as string),
    );

    expect(res.status).toBe(409);
  });
});
