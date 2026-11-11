import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { LEGACY_STEPS_REFUSAL_MESSAGE } from "@/lib/flows/manifest-shape";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

let getFlowPackageDetail: typeof import("@/lib/queries/flow-packages").getFlowPackageDetail;
let getStudioInstallForFlowRevision: typeof import("@/lib/queries/packages").getStudioInstallForFlowRevision;

const PROJECT_ID = randomUUID();
const FLOW_ID = randomUUID();
const REVISION_ID = randomUUID();
const LEGACY_REVISION_ID = randomUUID();
const MANIFEST = {
  schemaVersion: 1,
  name: "aif-dev",
  nodes: [
    {
      id: "run",
      type: "cli",
      action: { command: "true" },
      transitions: { success: "done" },
    },
  ],
};

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "flow_package_detail_test",
  });
  db = testDatabase.db;

  ({ getFlowPackageDetail } = await import("@/lib/queries/flow-packages"));
  ({ getStudioInstallForFlowRevision } =
    await import("@/lib/queries/packages"));

  await db.insert(schema.projects).values({
    id: PROJECT_ID,
    taskKey: "TFLOWFIX",
    slug: "flow-link-fix",
    name: "Flow Link Fix",
    repoPath: "/tmp/flow-link-fix-repo",
    maisterYamlPath: "/tmp/flow-link-fix-repo/maister.yaml",
  });

  // Reproduce the real-data inconsistency: the revision's source is a bare
  // absolute path, while the flows row's source is the SAME path with a
  // `file://` scheme. The viewer's revision filter must still match them.
  await db.insert(schema.flowRevisions).values({
    id: REVISION_ID,
    flowRefId: "aif-dev",
    source: "/tmp/pkg/flows/dev",
    versionLabel: "aif-v2.1.0",
    resolvedRevision: randomUUID().replace(/-/g, ""),
    manifestDigest: "test-digest",
    manifest: MANIFEST,
    schemaVersion: 1,
    installedPath: "/tmp/pkg/flows/dev",
    setupStatus: "not_required",
    packageStatus: "Installed",
    execTrust: "trusted",
  });
  await db.insert(schema.flowRevisions).values({
    id: LEGACY_REVISION_ID,
    flowRefId: "aif-dev",
    source: "/tmp/pkg/flows/dev",
    versionLabel: "aif-v1.0.0",
    resolvedRevision: randomUUID().replace(/-/g, ""),
    manifestDigest: "legacy-digest",
    manifest: { schemaVersion: 1, name: "aif-dev", steps: [] },
    schemaVersion: 1,
    installedPath: "/tmp/pkg/flows/dev-legacy",
    setupStatus: "not_required",
    packageStatus: "Installed",
    execTrust: "trusted",
  });

  await db.insert(schema.flows).values({
    id: FLOW_ID,
    projectId: PROJECT_ID,
    flowRefId: "aif-dev",
    source: "file:///tmp/pkg/flows/dev",
    version: "aif-v2.1.0",
    installedPath: "/tmp/pkg/flows/dev",
    manifest: MANIFEST,
    schemaVersion: 1,
    enabledRevisionId: REVISION_ID,
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("getFlowPackageDetail (integration)", () => {
  it("resolves the enabled revision when flows.source has a file:// prefix the revision source lacks", async () => {
    const detail = await getFlowPackageDetail("flow-link-fix", "aif-dev");

    expect(detail).not.toBeNull();
    // Pre-fix the exact-source filter matched 0 rows → the viewer page 404'd
    // (`if (!revision) notFound()`). Post-fix the `file://` scheme is stripped
    // on both sides, so the same-path revision matches.
    expect(detail?.revisions.map((r) => r.id)).toContain(REVISION_ID);
  });

  it("returns a typed incompatible DTO for a stored legacy revision", async () => {
    const detail = await getFlowPackageDetail("flow-link-fix", "aif-dev");
    const legacy = detail?.dto.revisions.find(
      (revision) => revision.id === LEGACY_REVISION_ID,
    );

    expect(legacy).toMatchObject({
      compatible: false,
      incompatibility: {
        kind: "legacy_steps",
        message: LEGACY_STEPS_REFUSAL_MESSAGE,
      },
    });
    expect(legacy).not.toHaveProperty("manifest");
    expect(legacy).not.toHaveProperty("installedPath");
  });

  it("opens a different-source revision only when the project and Flow row have a matching Run pin", async () => {
    const foreignProjectId = randomUUID();
    const foreignFlowId = randomUUID();
    const historicalRevisionId = randomUUID();
    const historicalSource = "file:///tmp/old-bundle/flows/dev";
    const resolvedRevision = randomUUID().replaceAll("-", "");

    await db.insert(schema.projects).values({
      id: foreignProjectId,
      taskKey: "TFOREIGNFLOW",
      slug: "flow-link-foreign",
      name: "Foreign Flow",
      repoPath: "/tmp/flow-link-foreign-repo",
      maisterYamlPath: "/tmp/flow-link-foreign-repo/maister.yaml",
    });
    await db.insert(schema.flowRevisions).values({
      id: historicalRevisionId,
      flowRefId: "aif-dev",
      source: historicalSource,
      versionLabel: "aif-v1.5.0",
      resolvedRevision,
      manifestDigest: "historical-digest",
      manifest: MANIFEST,
      schemaVersion: 1,
      installedPath: "/tmp/old-bundle/flows/dev",
      setupStatus: "not_required",
      packageStatus: "Installed",
      execTrust: "trusted",
    });
    await db.insert(schema.flows).values({
      id: foreignFlowId,
      projectId: foreignProjectId,
      flowRefId: "aif-dev",
      source: historicalSource,
      version: "aif-v1.5.0",
      installedPath: "/tmp/old-bundle/flows/dev",
      manifest: MANIFEST,
      schemaVersion: 1,
      enabledRevisionId: historicalRevisionId,
    });

    async function retainRun(projectId: string, flowId: string): Promise<void> {
      await db.insert(schema.runs).values({
        id: randomUUID(),
        projectId,
        flowId,
        runKind: "flow",
        status: "Done",
        flowVersion: "aif-v1.5.0",
        flowRevision: resolvedRevision,
        flowRevisionId: historicalRevisionId,
      });
    }

    const historicalSelection = { projectId: PROJECT_ID, historicalRevisionId };

    await retainRun(foreignProjectId, foreignFlowId);
    const foreignOnly = await getFlowPackageDetail(
      "flow-link-fix",
      "aif-dev",
      historicalSelection,
    );

    expect(foreignOnly?.revisions.map((revision) => revision.id)).not.toContain(
      historicalRevisionId,
    );

    await retainRun(PROJECT_ID, FLOW_ID);
    const pinned = await getFlowPackageDetail(
      "flow-link-fix",
      "aif-dev",
      historicalSelection,
    );
    const current = await getFlowPackageDetail("flow-link-fix", "aif-dev");

    expect(pinned?.revisions.map((revision) => revision.id)).toContain(
      historicalRevisionId,
    );
    expect(current?.revisions.map((revision) => revision.id)).not.toContain(
      historicalRevisionId,
    );
  });

  it("requires a proven Studio install when identical Git revisions are available from two sources", async () => {
    const detail = await getFlowPackageDetail("flow-link-fix", "aif-dev");
    const revision = detail?.revisions.find(
      (candidate) => candidate.id === REVISION_ID,
    );

    expect(revision).toBeDefined();

    const attached = randomUUID();
    const competing = randomUUID();
    const installedPath = "/tmp/package store/aif";
    const memberRevision = {
      ...revision!,
      source: pathToFileURL(`${installedPath}/flows/dev`).href,
    };

    await db.insert(schema.packageInstalls).values(
      [attached, competing].map((id) => ({
        id,
        name: "aif",
        sourceUrl: `file:///tmp/${id}`,
        installedPath,
        versionLabel: "aif/v2.1.0",
        resolvedRevision: revision!.resolvedRevision,
        manifestDigest: "test-digest",
        manifest: { spec: { flows: [{ id: "aif-dev", path: "flows/dev" }] } },
        packageStatus: "Installed",
      })),
    );
    expect(
      await getStudioInstallForFlowRevision(
        PROJECT_ID,
        "aif-dev",
        memberRevision,
      ),
    ).toBeNull();

    await db.insert(schema.projectPackageAttachments).values({
      id: randomUUID(),
      projectId: PROJECT_ID,
      packageInstallId: attached,
      packageName: "aif",
    });
    expect(
      await getStudioInstallForFlowRevision(
        PROJECT_ID,
        "aif-dev",
        memberRevision,
      ),
    ).toEqual({
      id: attached,
      name: "aif",
    });
  });
});
