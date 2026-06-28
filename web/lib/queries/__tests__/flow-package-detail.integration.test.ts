import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

let getFlowPackageDetail: typeof import("@/lib/queries/flow-packages").getFlowPackageDetail;

const PROJECT_ID = randomUUID();
const REVISION_ID = randomUUID();
const MANIFEST = { schemaVersion: 1, name: "aif-dev", steps: [] };

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("flow_package_detail_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ getFlowPackageDetail } = await import("@/lib/queries/flow-packages"));

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

  await db.insert(schema.flows).values({
    id: randomUUID(),
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
  await pool?.end();
  await container?.stop();
});

describe("getFlowPackageDetail (integration)", () => {
  it("resolves the enabled revision when flows.source has a file:// prefix the revision source lacks", async () => {
    const detail = await getFlowPackageDetail("flow-link-fix", "aif-dev");

    expect(detail).not.toBeNull();
    // Pre-fix the exact-source filter matched 0 rows → the viewer page 404'd
    // (`if (!revision) notFound()`). Post-fix the `file://` scheme is stripped
    // on both sides, so the same-path revision matches.
    expect(detail?.revisions.map((r) => r.id)).toEqual([REVISION_ID]);
  });
});
