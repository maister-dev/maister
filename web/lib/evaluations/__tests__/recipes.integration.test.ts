import type { RunnerCatalogEntry } from "@/lib/acp-runners/resolve";
import type {
  PreflightFlowRevision,
  PreflightMethodRequirements,
  PreflightOverlayCatalog,
} from "@/lib/evaluations/preflight";

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { createStudy } from "@/lib/evaluations/studies";
import {
  createControlledRecipe,
  preflightStudyRecipe,
  type PreflightContractLoaders,
} from "@/lib/evaluations/recipes";
import {
  computeArtifactContractDigest,
  computeInputContractDigest,
} from "@/lib/evaluations/recipe";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof fullSchema>;
let projectId: string;
let otherProjectId: string;
let flowId: string;
let taskId: string;

async function makeTask(project: string): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id,
    projectId: project,
    title: "T",
    prompt: "p",
    flowId,
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
    formKnownFields: ["title", "notes"],
    producedArtifactKinds: ["diff"],
    slotKeys: ["session:main"],
    requiredSlotKeys: [],
  };
}

function stubLoaders(
  flow: PreflightFlowRevision,
  method: PreflightMethodRequirements,
  runners: readonly RunnerCatalogEntry[],
): PreflightContractLoaders {
  const overlay: PreflightOverlayCatalog = {
    rules: new Set(),
    skills: new Set(),
    mcps: new Set(),
    subagents: new Set(),
  };

  return {
    loadFlowRevision: async () => flow,
    loadMethodRequirements: async () => method,
    loadRunnerCatalog: async () => runners,
    loadOverlayCatalog: async () => overlay,
  };
}

function recipeDefinition(
  flow: PreflightFlowRevision,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    flow: {
      flowRefId: flow.flowRefId,
      flowRevisionId: flow.flowRevisionId,
      inputContractDigest: computeInputContractDigest(flow),
      artifactContractDigest: computeArtifactContractDigest(flow),
    },
    inputs: { taskSnapshotRef: "snap-1", formValues: { title: "x" } },
    executionPolicy: { preset: "supervised" },
    slotBindings: { "session:main": { mode: "runner", runnerId: "runner-1" } },
  };
}

const runner: RunnerCatalogEntry = {
  id: "runner-1",
  adapter: "claude",
  capabilityAgent: "claude",
  model: "claude-sonnet-4-6",
  providerKind: "anthropic",
  permissionPolicy: "default",
  enabled: true,
  ready: true,
};

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_recipes_test",
  });
  db = testDatabase.db;

  projectId = randomUUID();
  otherProjectId = randomUUID();
  flowId = randomUUID();

  for (const [pid, slug] of [
    [projectId, "proj"],
    [otherProjectId, "other"],
  ] as const) {
    await db.insert(schema.projects).values({
      taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
      id: pid,
      slug: `${slug}-${pid.slice(0, 8)}`,
      name: slug,
      repoPath: `/tmp/${slug}-${pid.slice(0, 8)}`,
      maisterYamlPath: "/tmp/m.yaml",
    });
  }
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
  taskId = await makeTask(projectId);
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("createControlledRecipe", () => {
  it("creates a typed recipe with a content digest", async () => {
    const study = await createStudy({ projectId, taskId, title: "S1" }, db);
    const recipe = await createControlledRecipe(
      {
        studyId: study.id as string,
        projectId,
        key: "variant-a",
        label: "Variant A",
        definition: recipeDefinition(liveFlow()),
      },
      db,
    );

    expect(recipe.definitionDigest).toBeTruthy();
    expect(recipe.replicateGroup).toBeNull();
  });

  it("rejects an invalid recipe definition with CONFIG", async () => {
    const study = await createStudy({ projectId, taskId, title: "S2" }, db);

    await expect(
      createControlledRecipe(
        {
          studyId: study.id as string,
          projectId,
          key: "bad",
          label: "Bad",
          definition: { schemaVersion: 1 },
        },
        db,
      ),
    ).rejects.toThrow(/invalid controlled/i);
  });

  it("rejects a cross-project study", async () => {
    const study = await createStudy({ projectId, taskId, title: "S3" }, db);

    await expect(
      createControlledRecipe(
        {
          studyId: study.id as string,
          projectId: otherProjectId,
          key: "x",
          label: "X",
          definition: recipeDefinition(liveFlow()),
        },
        db,
      ),
    ).rejects.toThrow(/not found in project/);
  });

  it("rejects a duplicate recipe key with CONFLICT", async () => {
    const study = await createStudy({ projectId, taskId, title: "S4" }, db);
    const args = {
      studyId: study.id as string,
      projectId,
      key: "dup",
      label: "Dup",
      definition: recipeDefinition(liveFlow()),
    };

    await createControlledRecipe(args, db);
    await expect(createControlledRecipe(args, db)).rejects.toThrow(
      /already exists/i,
    );
  });

  it("returns the existing recipe (not CONFLICT) under returnExistingOnKeyConflict (M2 idempotency)", async () => {
    // The launch route re-derives a DETERMINISTIC inline key per
    // (idempotencyKey, index); an idempotent batch retry must resolve that key
    // to the SAME recipeId so the batch request digest matches (deduped) instead
    // of leaking a duplicate recipe + a 409 on digest mismatch.
    const study = await createStudy({ projectId, taskId, title: "S5" }, db);
    const args = {
      studyId: study.id as string,
      projectId,
      key: "idem-a",
      label: "Idem A",
      definition: recipeDefinition(liveFlow()),
      returnExistingOnKeyConflict: true,
    };

    const first = await createControlledRecipe(args, db);
    const second = await createControlledRecipe(args, db);

    expect(second.id).toBe(first.id);
  });

  it("rejects a returnExistingOnKeyConflict reuse whose definition changed (Codex-3)", async () => {
    // The launch route reuses a deterministic inline key across an idempotent
    // retry. If the SAME key arrives with a DIFFERENT definition, returning the
    // stored recipe would silently launch the wrong configuration — it must
    // CONFLICT on the digest mismatch instead of reusing the old recipe.
    const study = await createStudy({ projectId, taskId, title: "S6" }, db);
    const base = {
      studyId: study.id as string,
      projectId,
      key: "idem-b",
      label: "Idem B",
      returnExistingOnKeyConflict: true,
    };

    await createControlledRecipe(
      { ...base, definition: recipeDefinition(liveFlow()) },
      db,
    );

    const changed = {
      ...recipeDefinition(liveFlow()),
      executionPolicy: { preset: "assisted" },
    };

    await expect(
      createControlledRecipe({ ...base, definition: changed }, db),
    ).rejects.toThrow(/different definition/i);
  });
});

describe("preflightStudyRecipe", () => {
  it("returns ok for a fully compatible recipe", async () => {
    const study = await createStudy({ projectId, taskId, title: "P1" }, db);
    const flow = liveFlow();
    const result = await preflightStudyRecipe(
      {
        studyId: study.id as string,
        projectId,
        definition: recipeDefinition(flow),
      },
      stubLoaders(
        flow,
        { qualifiedId: "core:sdd-quality", requiredArtifactKinds: ["diff"] },
        [runner],
      ),
      db,
    );

    expect(result.ok).toBe(true);
  });

  it("surfaces refusals for an incompatible flow without side effects", async () => {
    const study = await createStudy({ projectId, taskId, title: "P2" }, db);
    const flow = liveFlow();
    const result = await preflightStudyRecipe(
      {
        studyId: study.id as string,
        projectId,
        definition: recipeDefinition(flow),
      },
      stubLoaders(
        { ...flow, trusted: false },
        {
          qualifiedId: "core:sdd-quality",
          requiredArtifactKinds: ["contract_report"],
        },
        [runner],
      ),
      db,
    );

    expect(result.ok).toBe(false);
    const codes = result.refusals.map((r) => r.code);

    expect(codes).toContain("flow_untrusted");
    expect(codes).toContain("artifact_requirement_uncovered");
  });

  it("hides a cross-project study as a 404 (ownership guard)", async () => {
    const study = await createStudy({ projectId, taskId, title: "P3" }, db);
    const flow = liveFlow();

    await expect(
      preflightStudyRecipe(
        {
          studyId: study.id as string,
          projectId: otherProjectId,
          definition: recipeDefinition(flow),
        },
        stubLoaders(
          flow,
          { qualifiedId: "core:sdd-quality", requiredArtifactKinds: [] },
          [runner],
        ),
        db,
      ),
    ).rejects.toThrow(/study not found/i);
  });
});
