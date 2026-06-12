import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { installPackage } from "@/lib/packages/install";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let homeDir: string;
let workspaceRoot: string;
let pkgDir: string;
let projectId: string;
let originalHome: string | undefined;

const FLOW_YAML = (name: string): string =>
  `schemaVersion: 1\nname: ${name}\nsteps:\n  - id: s1\n    type: cli\n    command: echo hi\n`;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("packages_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = await mkdtemp(join(tmpdir(), "pkg-int-home-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "pkg-int-ws-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  pkgDir = await mkdtemp(join(tmpdir(), "pkg-int-fixture-"));
  await mkdir(join(pkgDir, "flows/a"), { recursive: true });
  await mkdir(join(pkgDir, "flows/b"), { recursive: true });
  await mkdir(join(pkgDir, "capability/skills"), { recursive: true });
  await writeFile(join(pkgDir, "flows/a/flow.yaml"), FLOW_YAML("flow-a"));
  await writeFile(join(pkgDir, "flows/b/flow.yaml"), FLOW_YAML("flow-b"));
  await writeFile(join(pkgDir, "capability/skills/README.md"), "skills\n");
  await writeFile(
    join(pkgDir, "maister-package.yaml"),
    `schemaVersion: 1
name: intpkg
flows:
  - { id: flow-a, path: flows/a }
  - { id: flow-b, path: flows/b }
capabilities:
  - { id: int-bundle, path: capability }
`,
  );

  projectId = randomUUID();
  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: "pkg-int",
    name: "Pkg Int",
    repoPath: workspaceRoot,
    maisterYamlPath: join(workspaceRoot, "maister.yaml"),
  });
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await pool?.end();
  await container?.stop();
  await rm(homeDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(pkgDir, { recursive: true, force: true });
});

describe("installPackage (real pipeline, local source)", () => {
  it("installs 2 flows + bundle sharing ONE package revision", async () => {
    const result = await installPackage({
      source: pkgDir,
      version: "intpkg/v1.0.0",
      projectId,
      projectSlug: "pkg-int",
      workspaceRoot,
      db,
    });

    expect(result.name).toBe("intpkg");
    expect(result.resolvedRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(result.versionLabel).toBe("intpkg-v1.0.0");

    // Every member flow revision records the PACKAGE revision.
    const revisions = await db
      .select()
      .from(schema.flowRevisions)
      .where(
        eq(schema.flowRevisions.resolvedRevision, result.resolvedRevision),
      );

    expect(revisions.map((r: any) => r.flowRefId).sort()).toEqual([
      "flow-a",
      "flow-b",
    ]);

    const flowRows = await db
      .select()
      .from(schema.flows)
      .where(eq(schema.flows.projectId, projectId));

    expect(flowRows).toHaveLength(2);
    for (const row of flowRows) {
      expect(row.revision).toBe(result.resolvedRevision);
      expect(row.version).toBe("intpkg-v1.0.0");
    }

    // The capability bundle shares the same package revision.
    const imports = await db
      .select()
      .from(schema.capabilityImports)
      .where(eq(schema.capabilityImports.projectId, projectId));

    expect(imports).toHaveLength(1);
    expect(imports[0].capabilityRefId).toBe("int-bundle");
    expect(imports[0].resolvedRevision).toBe(result.resolvedRevision);

    expect(result.capabilityDerived).toHaveLength(1);
    expect(result.capabilityDerived[0]).toMatchObject({
      id: "int-bundle",
      revision: result.resolvedRevision,
    });
  });
});
