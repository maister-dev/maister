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
      flowRefId: projection.flowRefId,
      flowRevisionId: projection.flowRevisionId,
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

// Seed an ISOLATED flow + pinned revision (distinct flowRefId/revisionId) under
// the study project, so a bad launch-gate facet is exercised over the LIVE loader
// WITHOUT mutating the shared launchable flow the clean-path tests depend on.
// Overrides target the exact column the facet (`buildFlowContractProjection`) is
// computed from: enablement/trust live on `flows`, package/setup/schema on
// `flow_revisions`. Everything else mirrors the launchable baseline so the ONLY
// refusal a test can produce is the seeded one.
async function seedFlow(overrides: {
  flow?: Record<string, unknown>;
  revision?: Record<string, unknown>;
}): Promise<{ flowRefId: string; flowRevisionId: string }> {
  const ref = `flow-${randomUUID().slice(0, 8)}`;
  const revId = randomUUID();

  await db.insert(schema.flows).values({
    id: randomUUID(),
    projectId,
    flowRefId: ref,
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: GRAPH_MANIFEST,
    schemaVersion: 1,
    trustStatus: "trusted",
    enablementState: "Enabled",
    ...overrides.flow,
  });

  await db.insert(schema.flowRevisions).values({
    id: revId,
    flowRefId: ref,
    source: "github.com/x/y",
    versionLabel: "v1.0.0",
    resolvedRevision: "abc1234",
    manifestDigest: "digest-1",
    manifest: GRAPH_MANIFEST,
    schemaVersion: 1,
    installedPath: "/tmp/flows/bugfix",
    setupStatus: "not_required",
    packageStatus: "Installed",
    ...overrides.revision,
  });

  return { flowRefId: ref, flowRevisionId: revId };
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
    expect(result.refusals.map((r) => r.code)).toContain(
      "input_contract_drift",
    );
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

  // SECURITY-RELEVANT: a launch-disabled flow must never pass preflight. The
  // live loader reads enablement across BOTH rows (flows.enablementState +
  // revision package/setup status); a loader bug that mis-reads it would let a
  // non-launchable flow through, and this is the only live test that catches it.
  it("refuses a non-launchable flow enablement state (flow_not_launchable)", async () => {
    const study = await makeStudy("notlaunchable");
    const seeded = await seedFlow({ flow: { enablementState: "Disabled" } });
    const projection = await buildFlowContractProjection(
      { projectId, ...seeded },
      db,
    );

    expect(projection.enablementLaunchable).toBe(false);

    const result = await preflightStudyRecipe(
      { studyId: study.id, projectId, definition: recipeFor(projection) },
      livePreflightLoaders(db),
      db,
    );

    expect(result.ok).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain("flow_not_launchable");
  });

  it("refuses an untrusted flow package (flow_untrusted)", async () => {
    const study = await makeStudy("untrusted");
    const seeded = await seedFlow({ flow: { trustStatus: "untrusted" } });
    const projection = await buildFlowContractProjection(
      { projectId, ...seeded },
      db,
    );

    expect(projection.trusted).toBe(false);

    const result = await preflightStudyRecipe(
      { studyId: study.id, projectId, definition: recipeFor(projection) },
      livePreflightLoaders(db),
      db,
    );

    expect(result.ok).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain("flow_untrusted");
  });

  it("refuses an unsupported manifest schema version (schema_version_unsupported)", async () => {
    const study = await makeStudy("badschema");
    // The manifest JSONB stays valid (internal schemaVersion 1, parses fine); the
    // `flow_revisions.schema_version` COLUMN drives `isSchemaVersionSupported`.
    const seeded = await seedFlow({ revision: { schemaVersion: 2 } });
    const projection = await buildFlowContractProjection(
      { projectId, ...seeded },
      db,
    );

    expect(projection.schemaVersionSupported).toBe(false);

    const result = await preflightStudyRecipe(
      { studyId: study.id, projectId, definition: recipeFor(projection) },
      livePreflightLoaders(db),
      db,
    );

    expect(result.ok).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain(
      "schema_version_unsupported",
    );
  });

  // The live method-requirements loader resolves the profile's Method evidence
  // requirements; a required artifact kind the Flow never produces maps to
  // `artifact_requirement_uncovered` (NOT `artifact_contract_drift`, which is a
  // frozen-vs-live digest mismatch). Uses the shared launchable flow (produces
  // only "diff") + a seeded Method demanding "design-doc".
  it("refuses a method evidence requirement the flow never produces (artifact_requirement_uncovered)", async () => {
    const study = await makeStudy("uncovered");

    const installId = randomUUID();

    await db.insert(schema.packageInstalls).values({
      id: installId,
      sourceUrl: "github.com/x/core",
      name: "core",
      versionLabel: "v1.0.0",
      resolvedRevision: "deadbeef",
      manifest: { schemaVersion: 1, name: "core" },
      manifestDigest: "d",
      installedPath: "/tmp/core",
      packageStatus: "Installed",
      trustStatus: "trusted",
    });

    const methodRevisionId = randomUUID();

    await db.insert(schema.evaluationMethodRevisions).values({
      id: methodRevisionId,
      packageInstallId: installId,
      methodId: "sdd-quality",
      qualifiedId: "core:sdd-quality",
      packageName: "core",
      versionLabel: "v1.0.0",
      schemaVersion: 1,
      normalizedDefinition: {
        definition: { evidence: { requiredCoverage: ["design-doc"] } },
      },
      definitionDigest: "dd",
      promptDigest: "pd",
      schemaDigest: "sd",
      compat: { engineMin: "3.2.0" },
      activation: "enabled",
    });

    const panelId = randomUUID();

    await db.insert(schema.evaluationJudgePanels).values({
      id: panelId,
      name: "panel",
      roleBindings: [{ role: "judge", agentId: "core:judge" }],
      policy: {},
    });

    const profileId = randomUUID();

    await db.insert(schema.evaluationProfiles).values({
      id: profileId,
      name: "profile",
      methodRevisionId,
      panelId,
    });

    const projection = await buildFlowContractProjection(
      { projectId, flowRefId, flowRevisionId },
      db,
    );

    const result = await preflightStudyRecipe(
      {
        studyId: study.id,
        projectId,
        definition: recipeFor(projection),
        profileId,
      },
      livePreflightLoaders(db),
      db,
    );

    expect(result.ok).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain(
      "artifact_requirement_uncovered",
    );
  });
});
