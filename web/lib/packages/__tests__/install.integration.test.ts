import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { installPackageRevision } from "@/lib/packages/attach";
import { installPackage } from "@/lib/packages/install";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let homeDir: string;
let workspaceRoot: string;
let pkgDir: string;
let projectId: string;
let originalHome: string | undefined;

const FLOW_YAML = (name: string): string =>
  `schemaVersion: 1\nname: ${name}\ncompat:\n  engine_min: 1.1.0\nnodes:\n  - id: s1\n    type: cli\n    action:\n      command: echo hi\n    transitions:\n      success: done\n`;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "packages_test",
  });
  db = testDatabase.db;

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
  await testDatabase?.stop();
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

it("W02 installs all wait kinds at their exact engine floors", async () => {
  const source = await mkdtemp(join(tmpdir(), "pkg-int-wait-floors-"));

  onTestFinished(() => rm(source, { recursive: true, force: true }));
  const wait = (
    id: string,
    on: Record<string, unknown>,
    outcomes: readonly string[],
    next: string,
  ) => ({
    type: "wait",
    id,
    on,
    timeout: 120,
    transitions: Object.fromEntries(
      [...outcomes, "timeout", "cancelled"].map((outcome) => [outcome, next]),
    ),
  });
  const manifests = [
    {
      name: "wait-conditions-floor",
      compat: { engine_min: "3.14.0" },
      nodes: [
        wait("clock", { kind: "timer", after: 60 }, ["elapsed"], "comment"),
        wait("comment", { kind: "comment" }, ["commented"], "related"),
        wait(
          "related",
          { kind: "run", run_id: "linked-run", relation: "child" },
          ["done", "failed", "review", "crashed", "abandoned"],
          "report",
        ),
        wait(
          "report",
          { kind: "signal", name: "build", outcomes: ["ok"], bind: "head_sha" },
          ["ok", "stale"],
          "done",
        ),
      ],
    },
    {
      name: "remote-waits-floor",
      compat: { engine_min: "3.14.0" },
      nodes: [
        {
          type: "publish",
          id: "publish",
          pr: "ready",
          transitions: { success: "ci" },
        },
        wait(
          "ci",
          {
            kind: "ci",
            publication: "publish",
            transport: "pull",
            checks: ["build"],
            issuer: "github-actions",
          },
          ["success", "failure", "stale"],
          "pr",
        ),
        wait(
          "pr",
          { kind: "pr", publication: "publish" },
          ["merged", "closed", "conflict", "stale"],
          "done",
        ),
      ],
    },
  ];
  const flows = manifests.map(({ name }) => ({ id: name, path: name }));

  await writeFile(
    join(source, "maister-package.yaml"),
    JSON.stringify({ schemaVersion: 1, name: "wait-floors", flows }),
  );
  for (const manifest of manifests) {
    await mkdir(join(source, manifest.name));
    await writeFile(
      join(source, manifest.name, "flow.yaml"),
      JSON.stringify({ schemaVersion: 1, ...manifest }),
    );
  }
  const installed = await installPackageRevision({
    source,
    version: "local",
    db,
  });
  const revisions = await db
    .select({ id: schemaModule.flowRevisions.flowRefId })
    .from(schemaModule.flowRevisions)
    .where(
      eq(
        schemaModule.flowRevisions.resolvedRevision,
        installed.resolvedRevision,
      ),
    );

  expect(revisions.map(({ id }) => id).sort()).toEqual(
    flows.map(({ id }) => id).sort(),
  );
});
