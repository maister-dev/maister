import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { createStudy } from "@/lib/evaluations/studies";
import { preflightStudyRecipe } from "@/lib/evaluations/recipes";
import {
  buildFlowContractProjection,
  livePreflightLoaders,
} from "@/lib/evaluations/preflight-loaders";
import {
  computeArtifactContractDigest,
  computeInputContractDigest,
} from "@/lib/evaluations/recipe";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

// A single-node graph manifest that compiles: one ai_coding node in the default
// session producing a `diff` artifact. Yields slotKeys=["session:default"],
// producedArtifactKinds=["diff"], no form nodes.
const GRAPH_MANIFEST = {
  schemaVersion: 1,
  name: "Bugfix",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      output: { produces: [{ id: "d", kind: "diff" }] },
      transitions: { success: "done" },
    },
  ],
};

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof fullSchema>;
let projectId: string;
let otherProjectId: string;
let runnerId: string;
let flowRevisionId: string;
let flowRowId: string;
const flowRefId = "bugfix";

async function makeStudy(title: string): Promise<{ id: string }> {
  const taskId = randomUUID();

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    title,
    prompt: "do it",
    flowId: flowRowId,
  });

  return createStudy({ projectId, taskId, title }, db) as Promise<{
    id: string;
  }>;
}

// A recipe whose contract digests are computed from the REAL projection, so a
// clean recipe passes the drift gate. `override` mutates the definition to
// trigger a specific refusal class.
function recipeFor(
  projection: Awaited<ReturnType<typeof buildFlowContractProjection>>,
  override: (def: Record<string, unknown>) => void = () => {},
): Record<string, unknown> {
  const def: Record<string, unknown> = {
    schemaVersion: 1,
    flow: {
      flowRefId,
      flowRevisionId,
      inputContractDigest: computeInputContractDigest(projection),
      artifactContractDigest: computeArtifactContractDigest(projection),
    },
    inputs: { taskSnapshotRef: "snap-1", formValues: {} },
    executionPolicy: { preset: "supervised" },
    slotBindings: {
      "session:default": { mode: "runner", runnerId },
    },
  };

  override(def);

  return def;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_preflight_loaders_test",
  });
  db = testDatabase.db;

  projectId = randomUUID();
  otherProjectId = randomUUID();
  runnerId = randomUUID();
  flowRevisionId = randomUUID();

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

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));

  flowRowId = randomUUID();
  await db.insert(schema.flows).values({
    id: flowRowId,
    projectId,
    flowRefId,
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: GRAPH_MANIFEST,
    schemaVersion: 1,
    trustStatus: "trusted",
    enablementState: "Enabled",
  });

  await db.insert(schema.flowRevisions).values({
    id: flowRevisionId,
    flowRefId,
    source: "github.com/x/y",
    versionLabel: "v1.0.0",
    resolvedRevision: "abc1234",
    manifestDigest: "digest-1",
    manifest: GRAPH_MANIFEST,
    schemaVersion: 1,
    installedPath: "/tmp/flows/bugfix",
    setupStatus: "not_required",
    packageStatus: "Installed",
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("buildFlowContractProjection", () => {
  it("assembles slots, produced kinds, and launch-gate facets from live rows", async () => {
    const projection = await buildFlowContractProjection(
      { projectId, flowRefId, flowRevisionId },
      db,
    );

    expect(projection.slotKeys).toContain("session:default");
    expect(projection.producedArtifactKinds).toEqual(["diff"]);
    expect(projection.trusted).toBe(true);
    expect(projection.enablementLaunchable).toBe(true);
    expect(projection.engineCompatible).toBe(true);
    expect(projection.schemaVersionSupported).toBe(true);
  });

  it("throws PRECONDITION when the flow is missing for the project", async () => {
    await expect(
      buildFlowContractProjection(
        { projectId: otherProjectId, flowRefId, flowRevisionId },
        db,
      ),
    ).rejects.toThrow(/not found in project/);
  });

  it("throws PRECONDITION when the pinned revision is missing", async () => {
    await expect(
      buildFlowContractProjection(
        { projectId, flowRefId, flowRevisionId: randomUUID() },
        db,
      ),
    ).rejects.toThrow(/flow revision not found/);
  });
});

describe("preflightStudyRecipe over live loaders", () => {
  it("passes a compatible recipe (ok, no refusals)", async () => {
    const study = await makeStudy("clean");
    const projection = await buildFlowContractProjection(
      { projectId, flowRefId, flowRevisionId },
      db,
    );

    const result = await preflightStudyRecipe(
      { studyId: study.id, projectId, definition: recipeFor(projection) },
      livePreflightLoaders(db),
      db,
    );

    expect(result.ok).toBe(true);
    expect(result.refusals).toEqual([]);
  });

  it("refuses an unknown pinned runner (slot_runner_unavailable)", async () => {
    const study = await makeStudy("badrunner");
    const projection = await buildFlowContractProjection(
      { projectId, flowRefId, flowRevisionId },
      db,
    );

    const result = await preflightStudyRecipe(
      {
        studyId: study.id,
        projectId,
        definition: recipeFor(projection, (def) => {
          (def.slotBindings as Record<string, unknown>)["session:default"] = {
            mode: "runner",
            runnerId: "ghost-runner",
          };
        }),
      },
      livePreflightLoaders(db),
      db,
    );

    expect(result.ok).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain(
      "slot_runner_unavailable",
    );
  });

  it("refuses a stale contract digest (input_contract_drift)", async () => {
    const study = await makeStudy("drift");
    const projection = await buildFlowContractProjection(
      { projectId, flowRefId, flowRevisionId },
      db,
    );

    const result = await preflightStudyRecipe(
      {
        studyId: study.id,
        projectId,
        definition: recipeFor(projection, (def) => {
          (def.flow as Record<string, unknown>).inputContractDigest = "stale";
        }),
      },
      livePreflightLoaders(db),
      db,
    );

    expect(result.ok).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain("input_contract_drift");
  });

  it("refuses an unknown overlay ref (overlay_ref_unknown)", async () => {
    const study = await makeStudy("overlay");
    const projection = await buildFlowContractProjection(
      { projectId, flowRefId, flowRevisionId },
      db,
    );

    const result = await preflightStudyRecipe(
      {
        studyId: study.id,
        projectId,
        definition: recipeFor(projection, (def) => {
          def.capabilityOverlay = { skills: { add: ["ghost-skill"] } };
        }),
      },
      livePreflightLoaders(db),
      db,
    );

    expect(result.ok).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain("overlay_ref_unknown");
  });
});
