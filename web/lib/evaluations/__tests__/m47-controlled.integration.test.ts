import type { RunnerCatalogEntry } from "@/lib/acp-runners/resolve";
import type {
  PreflightFlowRevision,
  PreflightMethodRequirements,
  PreflightOverlayCatalog,
} from "@/lib/evaluations/preflight";
import type {
  LaunchRunSeam,
  CreateLaunchBatchArgs,
} from "@/lib/evaluations/launch-batch";
import type { PreflightContractLoaders } from "@/lib/evaluations/recipes";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { isLaunchedLineageRun } from "@/lib/evaluations/membership";
import {
  addObservedParticipants,
  createStudy,
} from "@/lib/evaluations/studies";
import {
  createControlledLaunchBatch,
  runControlledLaunchBatch,
} from "@/lib/evaluations/launch-batch";
import {
  computeArtifactContractDigest,
  computeInputContractDigest,
} from "@/lib/evaluations/recipe";
import {
  createControlledRecipe,
  preflightStudyRecipe,
} from "@/lib/evaluations/recipes";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let projectId: string;
let flowId: string;
let runnerId: string;
let taskId: string;

async function makeTask(): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id,
    projectId,
    title: "T",
    prompt: "p",
    flowId,
  });

  return id;
}

async function makeRun(): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.runs).values({
    id,
    taskId,
    projectId,
    flowId,
    runnerId,
    capabilityAgent: "claude",
    flowVersion: "v1.0.0",
    runKind: "flow",
  });

  return id;
}

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

async function newRecipe(studyId: string, key: string): Promise<string> {
  const recipe = await createControlledRecipe(
    {
      studyId,
      projectId,
      key,
      label: `Recipe ${key}`,
      definition: recipeDefinition(),
    },
    db,
  );

  return recipe.id as string;
}

const seam: LaunchRunSeam = async () => ({ runId: await makeRun() });

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

function stubLoaders(flow: PreflightFlowRevision): PreflightContractLoaders {
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

async function launchOne(studyId: string): Promise<string> {
  const recipeId = await newRecipe(studyId, `r-${randomUUID().slice(0, 6)}`);
  const { batchId } = await createControlledLaunchBatch(
    {
      studyId,
      projectId,
      items: [{ recipeId }],
    } satisfies CreateLaunchBatchArgs,
    db,
  );

  await runControlledLaunchBatch(batchId, seam, db);

  const [item] = await db
    .select()
    .from(schema.evaluationLaunchBatchItems)
    .where(eq(schema.evaluationLaunchBatchItems.batchId, batchId));

  return item.runId as string;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_m47_controlled_test",
  });
  db = testDatabase.db;

  projectId = randomUUID();
  flowId = randomUUID();
  runnerId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "proj",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
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
    manifest: { schemaVersion: 1, name: "Bugfix", nodes: [] },
    schemaVersion: 1,
  });
  taskId = await makeTask();
}, 180_000);

afterEach(() => {
  delete process.env.MAISTER_CONTROLLED_RECIPES_ENABLED;
});

afterAll(async () => {
  await testDatabase?.stop();
});

describe("M47 controlled evaluation surface", () => {
  it("launches a controlled participant that is in the launched lineage (no-auto-promotion)", async () => {
    const study = await createStudy({ projectId, taskId, title: "M1" }, db);
    const runId = await launchOne(study.id as string);

    // The launched run is in the launched lineage → excluded from auto-promotion
    // / auto-delivery at every consumer (D3/D15).
    expect(await isLaunchedLineageRun(db, runId)).toBe(true);
  });

  it("keeps an observed participant OUT of the launched lineage in a hybrid study", async () => {
    const study = await createStudy({ projectId, taskId, title: "M2" }, db);
    const observedRun = await makeRun();

    await addObservedParticipants(
      { studyId: study.id as string, runIds: [observedRun] },
      db,
    );
    const launchedRun = await launchOne(study.id as string);

    // Both coexist in one Study, but only the launched one is lineage-held.
    expect(await isLaunchedLineageRun(db, observedRun)).toBe(false);
    expect(await isLaunchedLineageRun(db, launchedRun)).toBe(true);

    const participants = await db
      .select()
      .from(schema.evaluationParticipants)
      .where(eq(schema.evaluationParticipants.studyId, study.id as string));
    const sources = participants
      .map((p: Record<string, unknown>) => p.sourceType)
      .sort();

    expect(sources).toEqual(["launched", "observed"]);
  });

  it("refuses an incompatible recipe at preflight with NO side effects (before worktree)", async () => {
    const study = await createStudy({ projectId, taskId, title: "M3" }, db);
    const result = await preflightStudyRecipe(
      {
        studyId: study.id as string,
        projectId,
        definition: recipeDefinition(),
      },
      stubLoaders({ ...liveFlow(), trusted: false }),
      db,
    );

    expect(result.ok).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain("flow_untrusted");

    // Preflight is read-only: no launch batch was created.
    const batches = await db
      .select()
      .from(schema.evaluationLaunchBatches)
      .where(eq(schema.evaluationLaunchBatches.studyId, study.id as string));

    expect(batches).toHaveLength(0);
  });

  it("passes preflight for a compatible recipe (exact contract)", async () => {
    const study = await createStudy({ projectId, taskId, title: "M4" }, db);
    const result = await preflightStudyRecipe(
      {
        studyId: study.id as string,
        projectId,
        definition: recipeDefinition(),
      },
      stubLoaders(liveFlow()),
      db,
    );

    expect(result.ok).toBe(true);
  });

  it("kill switch disables new controlled launches independently of observed studies", async () => {
    const study = await createStudy({ projectId, taskId, title: "M5" }, db);
    const recipeId = await newRecipe(study.id as string, "k");

    process.env.MAISTER_CONTROLLED_RECIPES_ENABLED = "false";

    await expect(
      createControlledLaunchBatch(
        { studyId: study.id as string, projectId, items: [{ recipeId }] },
        db,
      ),
    ).rejects.toThrow(/disabled on this platform/);

    // Observed comparison is unaffected by the kill switch.
    const observedRun = await makeRun();
    const added = await addObservedParticipants(
      { studyId: study.id as string, runIds: [observedRun] },
      db,
    );

    expect(added).toHaveLength(1);
  });
});
