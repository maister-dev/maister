import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
import {
  acquireLock,
  assertHoldsLock,
  readLockState,
  releaseLock,
} from "@/lib/local-packages/lock";
import {
  createLocalPackage,
  deleteLocalPackage,
  ensureDefaultLocalPackage,
  getDefaultLocalPackage,
  getLocalPackage,
  listFiles,
  listLocalPackages,
  readFileContent,
  setLocalPackageStatus,
} from "@/lib/local-packages/service";

// FIXME(any): dual drizzle peer-dep variants (matches attach.integration.test.ts).
const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schemaModule>;
let homeDir: string | undefined;
let originalHome: string | undefined;
let userId: string;
let otherUserId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("localpkg_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema: schemaModule });
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  // Working dirs resolve under ~/.maister/local — point HOME at a temp dir.
  homeDir = await mkdtemp(join(tmpdir(), "lp-int-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  userId = randomUUID();
  otherUserId = randomUUID();
  await db.insert(schema.users).values([
    { id: userId, email: `u-${userId}@x.test`, name: "Local Author" },
    {
      id: otherUserId,
      email: `u-${otherUserId}@x.test`,
      name: "Other Author",
    },
  ]);
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await pool?.end();
  await container?.stop();
  if (homeDir !== undefined) {
    await rm(homeDir, { recursive: true, force: true });
  }
});

describe("local-packages substrate (integration)", () => {
  let pkgId: string;
  let workingDir: string;

  it("creates a local package: row + git-backed scaffold", async () => {
    const pkg = await createLocalPackage({
      name: "My Flow Pack",
      createdBy: userId,
      db,
    });

    pkgId = pkg.id;
    workingDir = pkg.workingDir;
    expect(pkg.slug).toBe("my-flow-pack");
    expect(pkg.status).toBe("active");
    expect(pkg.branchName).toBe("main");
    expect(pkg.workingDir).toContain(join(".maister", "local"));

    const files = await listFiles(pkg);

    expect(files.some((f) => f.path === "maister-package.yaml")).toBe(true);
    expect((await stat(join(pkg.workingDir, ".git"))).isDirectory()).toBe(true);
  });

  it("reads the scaffolded manifest with a content hash", async () => {
    const pkg = await getLocalPackage(pkgId, db);

    expect(pkg).not.toBeNull();
    const f = await readFileContent(pkg!, "maister-package.yaml");

    expect(f.kind).toBe("manifest");
    expect(f.content).toContain("name: My Flow Pack");
    expect(f.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("allocates a unique slug on name collision", async () => {
    const dup = await createLocalPackage({
      name: "My Flow Pack",
      createdBy: userId,
      db,
    });

    expect(dup.slug).toBe("my-flow-pack-2");
    await deleteLocalPackage(dup.id, db);
  });

  it("session lock: acquire, hold, same-user takeover, read-only for other users, lazy stale-takeover", async () => {
    const s1 = await acquireLock(pkgId, userId, "session-1", db);

    expect(s1.heldByMe).toBe(true);
    await expect(
      assertHoldsLock(pkgId, "session-1", db),
    ).resolves.toBeUndefined();

    // The same user can reopen the editor and reclaim their own stale tab lock.
    const s2 = await acquireLock(pkgId, userId, "session-2", db);

    expect(s2.held).toBe(true);
    expect(s2.heldByMe).toBe(true);
    await expect(assertHoldsLock(pkgId, "session-1", db)).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
    await expect(
      assertHoldsLock(pkgId, "session-2", db),
    ).resolves.toBeUndefined();

    // Another user still cannot acquire a live lock.
    const other = await acquireLock(pkgId, otherUserId, "session-3", db);

    expect(other.held).toBe(true);
    expect(other.heldByMe).toBe(false);
    await expect(assertHoldsLock(pkgId, "session-3", db)).rejects.toMatchObject(
      { code: "CONFLICT" },
    );

    // expire session-2's lock, then another user takes over (lazy stale-takeover)
    await db
      .update(schema.localPackages)
      .set({ lockExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.localPackages.id, pkgId));
    expect(
      (await acquireLock(pkgId, otherUserId, "session-3", db)).heldByMe,
    ).toBe(true);

    await releaseLock(pkgId, "session-3", db);
    expect((await readLockState(pkgId, "session-1", db)).held).toBe(false);
  });

  it("archive hides the package from the active list", async () => {
    await setLocalPackageStatus(pkgId, "archived", db);
    const active = await listLocalPackages(db);

    expect(active.some((p) => p.id === pkgId)).toBe(false);
  });

  it("delete removes the row and the working dir", async () => {
    const pkg = await createLocalPackage({
      name: "Throwaway Pack",
      createdBy: userId,
      db,
    });

    await deleteLocalPackage(pkg.id, db);
    expect(await getLocalPackage(pkg.id, db)).toBeNull();
    await expect(stat(pkg.workingDir)).rejects.toBeTruthy();
    // the archived package's working dir is untouched by the active-list query
    expect((await stat(workingDir)).isDirectory()).toBe(true);
  });

  it("delete refuses a local package attached to a project", async () => {
    const projectId = randomUUID();

    await db.insert(schema.projects).values({
      taskKey: `D${randomUUID().slice(0, 8)}`.toUpperCase(),
      id: projectId,
      slug: `delete-guard-${projectId.slice(0, 8)}`,
      name: "Delete Guard",
      repoPath: join(homeDir!, `repo-delete-guard-${projectId.slice(0, 8)}`),
    });

    const attached = await ensureDefaultLocalPackage({
      projectId,
      projectName: "Delete Guard",
      createdBy: userId,
      db,
    });

    await expect(deleteLocalPackage(attached.id, db)).rejects.toMatchObject({
      code: "PRECONDITION",
    });
    expect(await getLocalPackage(attached.id, db)).not.toBeNull();
    expect((await stat(attached.workingDir)).isDirectory()).toBe(true);
  });

  it("delete refuses a local package with a live edit lock", async () => {
    const locked = await createLocalPackage({
      name: "Locked Pack",
      createdBy: userId,
      db,
    });

    await acquireLock(locked.id, userId, "delete-guard-session", db);

    await expect(deleteLocalPackage(locked.id, db)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await getLocalPackage(locked.id, db)).not.toBeNull();
    expect((await stat(locked.workingDir)).isDirectory()).toBe(true);

    await releaseLock(locked.id, "delete-guard-session", db);
    await deleteLocalPackage(locked.id, db);
  });

  it("two concurrent default creations keep the winner's repo (no shared-dir delete)", async () => {
    const projectId = randomUUID();

    await db.insert(schema.projects).values({
      taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
      id: projectId,
      slug: `race-${projectId.slice(0, 8)}`,
      name: "Race Proj",
      repoPath: join(homeDir!, `repo-race-${projectId.slice(0, 8)}`),
    });

    expect(await getDefaultLocalPackage(projectId, db)).toBeNull();

    // Both racers create the project default concurrently. The fix: each derives
    // its OWN unique working dir, so the insert loser rolls back only its own
    // orphan — never the winner's adopted repo (the critical data-loss bug).
    const [a, b] = await Promise.all([
      ensureDefaultLocalPackage({
        projectId,
        projectName: "Race Proj",
        createdBy: userId,
        db,
      }),
      ensureDefaultLocalPackage({
        projectId,
        projectName: "Race Proj",
        createdBy: userId,
        db,
      }),
    ]);

    // Both resolve to the same winning row, and it is the project's sole default.
    expect(a.id).toBe(b.id);
    expect(a.isDefault).toBe(true);
    const rows = await db
      .select()
      .from(schema.localPackages)
      .where(eq(schema.localPackages.projectId, projectId));

    expect(rows.filter((r) => r.isDefault)).toHaveLength(1);

    // The surviving row's repo EXISTS — the loser did not delete a shared dir.
    expect((await stat(a.workingDir)).isDirectory()).toBe(true);
    expect((await stat(join(a.workingDir, ".git"))).isDirectory()).toBe(true);
  });
});
