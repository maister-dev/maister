import type { RunnerCatalogEntry } from "@/lib/acp-runners/resolve";
import type {
  PreflightFlowRevision,
  PreflightMethodRequirements,
  PreflightOverlayCatalog,
} from "@/lib/evaluations/preflight";
import type { PreflightContractLoaders } from "@/lib/evaluations/recipes";

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  computeArtifactContractDigest,
  computeInputContractDigest,
} from "@/lib/evaluations/recipe";
import { createControlledRecipe } from "@/lib/evaluations/recipes";
import {
  checkStandardizationEligible,
  getCurrentStandardizedRecipe,
  rollbackStandardization,
  standardizeRecipe,
} from "@/lib/evaluations/standardization";
import { createStudy } from "@/lib/evaluations/studies";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof fullSchema>;
let projectId: string;
let flowId: string;
let taskId: string;
let userId: string;

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

function loaders(
  flow: PreflightFlowRevision = liveFlow(),
): PreflightContractLoaders {
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
    loadFlowRevision: async () => flow,
    loadMethodRequirements: async () => method,
    loadRunnerCatalog: async () => [runner],
    loadOverlayCatalog: async () => overlay,
  };
}

function recipeDefinition(): Record<string, unknown> {
  const flow = liveFlow();

  return {
    schemaVersion: 1,
    flow: {
      flowRefId: flow.flowRefId,
      flowRevisionId: flow.flowRevisionId,
      inputContractDigest: computeInputContractDigest(flow),
      artifactContractDigest: computeArtifactContractDigest(flow),
    },
    inputs: { taskSnapshotRef: "snap", formValues: { title: "x" } },
    executionPolicy: { preset: "supervised" },
    slotBindings: { "session:main": { mode: "runner", runnerId: "r1" } },
  };
}

// Seed a decided Study whose winner is a launched participant with a recipe.
async function decidedStudyWithLaunchedWinner(): Promise<{
  studyId: string;
  recipeId: string;
}> {
  const study = await createStudy(
    { projectId, taskId, title: `S-${randomUUID().slice(0, 6)}` },
    db,
  );
  const recipe = await createControlledRecipe(
    {
      studyId: study.id as string,
      projectId,
      key: "winner",
      label: "Winner",
      definition: recipeDefinition(),
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

  return { studyId: study.id as string, recipeId: recipe.id as string };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_standardization_test",
  });
  db = testDatabase.db;

  projectId = randomUUID();
  flowId = randomUUID();
  userId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "proj",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db.insert(schema.users).values({
    id: userId,
    email: `u-${userId.slice(0, 8)}@x.io`,
    role: "admin",
  });
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

describe("checkStandardizationEligible", () => {
  it("is eligible for a conclusive launched winner passing a fresh preflight", async () => {
    const { studyId } = await decidedStudyWithLaunchedWinner();
    const result = await checkStandardizationEligible(
      { studyId, projectId },
      loaders(),
      db,
    );

    expect(result.eligible).toBe(true);
    expect(result.refusals).toEqual([]);
    expect(result.sourceRecipeId).toBeTruthy();
  });

  it("refuses when there is no conclusive winner verdict", async () => {
    const study = await createStudy({ projectId, taskId, title: "NoV" }, db);
    const result = await checkStandardizationEligible(
      { studyId: study.id as string, projectId },
      loaders(),
      db,
    );

    expect(result.eligible).toBe(false);
    expect(result.refusals).toContain("no_conclusive_winner");
  });

  it("refuses when the winner is an observed participant (no recipe)", async () => {
    const study = await createStudy({ projectId, taskId, title: "Obs" }, db);
    const participantId = randomUUID();

    await db.insert(schema.evaluationParticipants).values({
      id: participantId,
      studyId: study.id as string,
      sourceType: "observed",
      label: "Observed",
    });
    await db.insert(schema.evaluationHumanVerdicts).values({
      studyId: study.id as string,
      outcome: "winner",
      participantIds: [participantId],
      executionIds: [],
      noEvaluationEvidenceAck: true,
    });

    const result = await checkStandardizationEligible(
      { studyId: study.id as string, projectId },
      loaders(),
      db,
    );

    expect(result.refusals).toContain("winner_not_launched_recipe");
  });

  it("refuses on an incompatible fresh preflight (stale/incompatible dependency)", async () => {
    const { studyId } = await decidedStudyWithLaunchedWinner();
    const result = await checkStandardizationEligible(
      { studyId, projectId },
      loaders({ ...liveFlow(), trusted: false }),
      db,
    );

    expect(result.eligible).toBe(false);
    expect(result.refusals.some((r) => r.startsWith("preflight:"))).toBe(true);
  });
});

describe("standardizeRecipe + rollback", () => {
  it("writes a project-default revision and re-standardizing bumps the revision", async () => {
    const { studyId } = await decidedStudyWithLaunchedWinner();

    const first = await standardizeRecipe(
      { studyId, projectId, actorUserId: userId },
      loaders(),
      db,
    );

    expect(first.revision).toBe(1);
    expect(first.action).toBe("standardize");

    const second = await decidedStudyWithLaunchedWinner();

    await standardizeRecipe(
      { studyId: second.studyId, projectId, actorUserId: userId },
      loaders(),
      db,
    );

    const current = await getCurrentStandardizedRecipe({ projectId }, db);

    expect(current?.revision).toBe(2);
  });

  it("refuses to standardize an ineligible study (CONFLICT, no config write)", async () => {
    const study = await createStudy({ projectId, taskId, title: "Bad" }, db);

    await expect(
      standardizeRecipe(
        { studyId: study.id as string, projectId, actorUserId: userId },
        loaders(),
        db,
      ),
    ).rejects.toThrow(/not eligible/);
  });

  it("rolls back to the prior revision (audited, append-only)", async () => {
    // Two standardizations already exist from the earlier test → rollback works.
    const rolled = await rollbackStandardization(
      { projectId, actorUserId: userId },
      db,
    );

    expect(rolled.action).toBe("rollback");
    expect(rolled.rolledBackToRevision).toBeTruthy();

    const current = await getCurrentStandardizedRecipe({ projectId }, db);

    expect(current?.action).toBe("rollback");
    // The rollback restored a prior definition digest.
    expect(current?.definitionDigest).toBe(rolled.definitionDigest);
  });

  it("refuses rollback for a slot with a single revision", async () => {
    await expect(
      rollbackStandardization(
        { projectId, slot: "fresh-slot", actorUserId: userId },
        db,
      ),
    ).rejects.toThrow(/no prior standardized revision/);
  });
});

describe("revision allocation race (per-(project, slot) serialization)", () => {
  // Uses a dedicated slot so the default-slot revisions of the earlier tests
  // never leak into the expected numbering.
  const slot = "race-slot";

  it("serializes two concurrent standardize calls into sequential revisions (no 23505)", async () => {
    const a = await decidedStudyWithLaunchedWinner();
    const b = await decidedStudyWithLaunchedWinner();

    // Both racers read coalesce(max(revision),0)+1 for an EMPTY slot — without
    // the advisory lock they collide on UNIQUE(project, slot, revision).
    const [first, second] = await Promise.all([
      standardizeRecipe(
        { studyId: a.studyId, projectId, slot, actorUserId: userId },
        loaders(),
        db,
      ),
      standardizeRecipe(
        { studyId: b.studyId, projectId, slot, actorUserId: userId },
        loaders(),
        db,
      ),
    ]);

    expect(
      [Number(first.revision), Number(second.revision)].sort((x, y) => x - y),
    ).toEqual([1, 2]);
  });

  it("keeps a rollback racing a standardize serial", async () => {
    const { studyId } = await decidedStudyWithLaunchedWinner();

    // Two revisions exist from the racer test, so rollback is legal in either
    // interleaving. Both must succeed with distinct sequential revisions.
    const [standardized, rolled] = await Promise.all([
      standardizeRecipe(
        { studyId, projectId, slot, actorUserId: userId },
        loaders(),
        db,
      ),
      rollbackStandardization({ projectId, slot, actorUserId: userId }, db),
    ]);

    expect(
      [Number(standardized.revision), Number(rolled.revision)].sort(
        (x, y) => x - y,
      ),
    ).toEqual([3, 4]);
  });
});
