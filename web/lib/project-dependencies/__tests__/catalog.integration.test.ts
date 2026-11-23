import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { reconcileDependencyCatalog } from "@/lib/project-dependencies/catalog";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "dependency_catalog",
  });
}, 180000);
afterAll(async () => {
  await database?.stop();
});

it("AC05 rebuilds realized bundles without overwriting another owner or losing catalog selections", async () => {
  const db = drizzle(database.pool, { schema });
  const projectId = "project";
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Project",
    slug: "project",
    repoPath: "/tmp/project",
    taskKey: "PRO",
  });
  await db.insert(schema.capabilityImports).values(
    ["bundle", "collision"].map((id) => ({
      id,
      capabilityRefId: id,
      projectId,
      source: "file:///tmp/source",
      versionTag: "v1",
      resolvedRevision: "revision",
      manifestDigest: "digest",
      manifest: {},
      installedPath: "/tmp/cache",
      setupStatus: "done" as const,
      packageStatus: "Installed" as const,
      trustStatus: "trusted" as const,
    })),
  );
  const base = {
    projectId,
    agents: ["claude" as const],
    label: "selection",
    selectedByDefault: false,
  };
  await db.insert(schema.capabilityRecords).values([
    {
      ...base,
      id: "old-bundle",
      source: "flow-package",
      kind: "agent_definition",
      capabilityRefId: "bundle",
      material: {},
      version: "v1",
      revision: "revision",
    },
    {
      ...base,
      id: "collision",
      source: "flow-package",
      kind: "agent_definition",
      capabilityRefId: "collision",
      material: {},
    },
    {
      ...base,
      id: "platform",
      source: "platform",
      kind: "mcp",
      capabilityRefId: "mcp",
      material: {},
    },
    {
      ...base,
      id: "configured",
      source: "project",
      kind: "rule",
      capabilityRefId: "rule",
      material: {},
    },
    {
      ...base,
      id: "authored",
      source: "project",
      kind: "skill",
      capabilityRefId: "skill",
      material: { origin: "authored" },
    },
    {
      ...base,
      id: "package",
      source: "flow-package",
      kind: "skill",
      capabilityRefId: "package-skill",
      material: { origin: "package-attachment" },
    },
  ]);
  const rebuild = () =>
    db.transaction((tx) => reconcileDependencyCatalog(tx, projectId));
  await expect(rebuild()).rejects.toMatchObject({ code: "CONFLICT" });
  await database.pool.query(
    "DELETE FROM capability_imports WHERE id='collision'",
  );
  const snapshot = () =>
    database.pool.query(
      "SELECT id,material,selectable,selected_by_default,disabled_at FROM capability_records WHERE project_id='project' ORDER BY id",
    );
  const before = (await snapshot()).rows;
  await rebuild();
  const active = (await snapshot()).rows;
  expect(active.filter((r) => r.id !== "old-bundle")).toEqual(
    before.filter((r) => r.id !== "old-bundle"),
  );
  expect(active.find((r) => r.id === "old-bundle")).toMatchObject({
    material: { origin: "dependency-import", importId: "bundle" },
    selected_by_default: false,
    selectable: true,
  });
  await database.pool.query(
    "UPDATE capability_imports SET setup_status='failed',package_status='Failed' WHERE id='bundle'",
  );
  await rebuild();
  expect(
    (await snapshot()).rows.find((r) => r.id === "old-bundle"),
  ).toMatchObject({
    selectable: false,
    selected_by_default: false,
    disabled_at: expect.any(Date),
  });
});
