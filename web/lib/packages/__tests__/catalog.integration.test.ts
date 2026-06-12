import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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
import { isMaisterError } from "@/lib/errors";
import {
  createPackageSource,
  deletePackageSource,
  refreshPackageSource,
  updatePackageSource,
} from "@/lib/packages/catalog";

const schema = schemaModule as unknown as Record<string, any>;
const execFileAsync = promisify(execFile);

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let fixtureRepo: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("catalog_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  // Local git monorepo fixture: packages/aif + per-package tags.
  fixtureRepo = await mkdtemp(join(tmpdir(), "pkg-catalog-repo-"));
  await git(fixtureRepo, "init", "-b", "main");
  await mkdir(join(fixtureRepo, "packages/aif/flows/dev"), { recursive: true });
  await writeFile(
    join(fixtureRepo, "packages/aif/maister-package.yaml"),
    "schemaVersion: 1\nname: aif\nflows:\n  - { id: aif-dev, path: flows/dev }\n",
  );
  await writeFile(
    join(fixtureRepo, "packages/aif/flows/dev/flow.yaml"),
    "schemaVersion: 1\nname: aif-dev\nsteps:\n  - id: s1\n    type: cli\n    command: echo hi\n",
  );
  await git(fixtureRepo, "add", "-A");
  await git(fixtureRepo, "commit", "-m", "init");
  await git(fixtureRepo, "tag", "aif/v1.0.0");
  await git(fixtureRepo, "tag", "aif/v2.0.0");
  await git(fixtureRepo, "tag", "unrelated-tag");
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  await rm(fixtureRepo, { recursive: true, force: true });
});

describe("package source catalog (integration)", () => {
  it("CRUD: create, dup-url CONFLICT, update, delete", async () => {
    const { id } = await createPackageSource({
      url: fixtureRepo,
      note: "fixture",
      db,
    });

    await expect(
      createPackageSource({ url: fixtureRepo, db }),
    ).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "CONFLICT",
    );

    expect(
      (await updatePackageSource({ id, enabled: false, db })).updated,
    ).toBe(true);
    expect(
      (await updatePackageSource({ id: randomUUID(), enabled: true, db }))
        .updated,
    ).toBe(false);

    expect((await deletePackageSource({ id, db })).deleted).toBe(true);
    expect((await deletePackageSource({ id, db })).deleted).toBe(false);
  });

  it("refresh discovers manifest packages × tags from a real local repo", async () => {
    const { id } = await createPackageSource({ url: fixtureRepo, db });
    const result = await refreshPackageSource({ id, db });

    expect(result).not.toBeNull();
    expect(result!.degraded).toBe(false);
    expect(result!.packages).toEqual([
      { name: "aif", dir: "aif", tags: ["aif/v2.0.0", "aif/v1.0.0"] },
    ]);

    const [row] = await db
      .select()
      .from(schema.packageSources)
      .where(eq(schema.packageSources.id, id));

    expect(row.discovered).toEqual(result!.packages);
    expect(row.lastCheckedAt).not.toBeNull();

    await deletePackageSource({ id, db });
  });

  it("refresh degrades to the stale snapshot when the remote is dead", async () => {
    const { id } = await createPackageSource({
      url: join(tmpdir(), "definitely-missing-repo-dir"),
      db,
    });

    // Seed a stale snapshot to prove it survives the failed refresh.
    await db
      .update(schema.packageSources)
      .set({
        discovered: [{ name: "stale", dir: "stale", tags: ["stale/v1.0.0"] }],
      })
      .where(eq(schema.packageSources.id, id));

    const result = await refreshPackageSource({ id, db });

    expect(result!.degraded).toBe(true);
    expect(result!.packages).toEqual([
      { name: "stale", dir: "stale", tags: ["stale/v1.0.0"] },
    ]);

    const [row] = await db
      .select()
      .from(schema.packageSources)
      .where(eq(schema.packageSources.id, id));

    expect(row.lastCheckedAt).toBeNull();
    await deletePackageSource({ id, db });
  });

  it("delete is usage-guarded while installs from the source are attached", async () => {
    const { id } = await createPackageSource({
      url: "github.com/x/guarded",
      db,
    });
    const projectId = randomUUID();

    await db.insert(schema.projects).values({
      taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
      id: projectId,
      slug: `guard-${randomUUID().slice(0, 6)}`,
      name: "Guard",
      repoPath: `/tmp/guard-${randomUUID().slice(0, 6)}`,
      maisterYamlPath: "/tmp/guard/maister.yaml",
    });
    const installId = randomUUID();

    await db.insert(schema.packageInstalls).values({
      id: installId,
      sourceUrl: "github.com/x/guarded",
      name: "aif",
      versionLabel: "aif/v1.0.0",
      resolvedRevision: "a".repeat(40),
      manifest: { schemaVersion: 1, name: "aif", flows: [] },
      manifestDigest: "d".repeat(40),
      installedPath: "/tmp/cache/aif",
      packageStatus: "Installed",
    });
    await db.insert(schema.projectPackageAttachments).values({
      id: randomUUID(),
      projectId,
      packageInstallId: installId,
      packageName: "aif",
    });

    await expect(deletePackageSource({ id, db })).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "CONFLICT",
    );

    await db
      .delete(schema.projectPackageAttachments)
      .where(eq(schema.projectPackageAttachments.packageInstallId, installId));
    expect((await deletePackageSource({ id, db })).deleted).toBe(true);
  });
});
