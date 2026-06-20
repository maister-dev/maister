import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { assertHoldsLock } from "@/lib/local-packages/lock";
import {
  commitWorkingDir,
  createLocalPackage,
  diffWorkingDir,
  discardWorkingDir,
  getLocalPackage,
  writeWorkingDirFile,
} from "@/lib/local-packages/service";

// FIXME(any): dual drizzle peer-dep variants (matches service.integration.test.ts).
const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schemaModule>;
let homeDir: string;
let originalHome: string | undefined;
let userId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("localpkg_diff_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema: schemaModule });
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  // Working dirs resolve under ~/.maister/local — point HOME at a temp dir.
  homeDir = await mkdtemp(join(tmpdir(), "lp-diff-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  userId = randomUUID();
  await db
    .insert(schema.users)
    .values({ id: userId, email: `u-${userId}@x.test`, name: "Local Author" });
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await pool?.end();
  await container?.stop();
  await rm(homeDir, { recursive: true, force: true });
});

// (M36 T4.3) git-backed diff + commit/discard over the local-package working
// dir. The diff is working-tree-vs-HEAD (uncommitted edits); commit clears it;
// discard restores HEAD; a confined-path discard scopes the restore; and the
// write-side ops are gated by the session edit-lock (asserted by the routes).
describe("local-package git diff/commit/discard (integration)", () => {
  let pkgId: string;

  it("creates a clean, committed local package (diff empty)", async () => {
    const pkg = await createLocalPackage({
      name: "Diff Pack",
      createdBy: userId,
      db,
    });

    pkgId = pkg.id;
    const diff = await diffWorkingDir(pkg);

    expect(diff.changedCount).toBe(0);
    expect(diff.files).toHaveLength(0);
    expect(diff.truncated).toBe(false);
  });

  it("an edited working-dir file shows in the diff (changed-count > 0)", async () => {
    const pkg = (await getLocalPackage(pkgId, db))!;

    await writeWorkingDirFile(pkg, "flows/demo.yaml", "name: demo\n");

    const diff = await diffWorkingDir(pkg);

    expect(diff.changedCount).toBe(1);
    expect(diff.files.map((f) => f.path)).toContain("flows/demo.yaml");
    // An added file with content prepares a renderable per-file bundle.
    expect(diff.perFile.some((f) => f.path === "flows/demo.yaml")).toBe(true);
  });

  it("commit clears the working-tree diff (changed-count 0)", async () => {
    const pkg = (await getLocalPackage(pkgId, db))!;

    await commitWorkingDir(pkg, "add demo flow");

    const diff = await diffWorkingDir(pkg);

    expect(diff.changedCount).toBe(0);
    // The committed file is still on disk (commit, not discard).
    expect(
      await readFile(join(pkg.workingDir, "flows/demo.yaml"), "utf8"),
    ).toBe("name: demo\n");
  });

  it("discard (no paths) restores the whole tree to HEAD", async () => {
    const pkg = (await getLocalPackage(pkgId, db))!;

    // Modify a committed file + add a brand-new untracked file.
    await writeWorkingDirFile(pkg, "flows/demo.yaml", "name: CHANGED\n");
    await writeWorkingDirFile(pkg, "flows/untracked.yaml", "name: temp\n");
    expect((await diffWorkingDir(pkg)).changedCount).toBe(2);

    await discardWorkingDir(pkg);

    const diff = await diffWorkingDir(pkg);

    expect(diff.changedCount).toBe(0);
    // tracked file restored to HEAD content; untracked file removed.
    expect(
      await readFile(join(pkg.workingDir, "flows/demo.yaml"), "utf8"),
    ).toBe("name: demo\n");
    await expect(
      readFile(join(pkg.workingDir, "flows/untracked.yaml"), "utf8"),
    ).rejects.toBeTruthy();
  });

  it("discard with a confined path restores ONLY that path", async () => {
    const pkg = (await getLocalPackage(pkgId, db))!;

    await writeWorkingDirFile(pkg, "flows/demo.yaml", "name: edit-a\n");
    await writeWorkingDirFile(pkg, "maister-package.yaml", "edited: true\n");
    expect((await diffWorkingDir(pkg)).changedCount).toBe(2);

    await discardWorkingDir(pkg, ["flows/demo.yaml"]);

    const diff = await diffWorkingDir(pkg);

    // demo.yaml restored; maister-package.yaml edit survives.
    expect(diff.files.map((f) => f.path)).toEqual(["maister-package.yaml"]);
    expect(
      await readFile(join(pkg.workingDir, "flows/demo.yaml"), "utf8"),
    ).toBe("name: demo\n");

    // restore the rest so later assertions start clean
    await discardWorkingDir(pkg);
    expect((await diffWorkingDir(pkg)).changedCount).toBe(0);
  });

  it("a discard path that escapes the working dir is rejected (PRECONDITION)", async () => {
    const pkg = (await getLocalPackage(pkgId, db))!;

    await expect(
      discardWorkingDir(pkg, ["../escape.yaml"]),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    await expect(discardWorkingDir(pkg, [".git/config"])).rejects.toMatchObject(
      { code: "PRECONDITION" },
    );
  });

  it("commit/discard are gated by the session edit-lock (CONFLICT without one)", async () => {
    // The routes call assertHoldsLock BEFORE the git op. With no live lock for a
    // session, the assertion (the gate) rejects with CONFLICT.
    await expect(
      assertHoldsLock(pkgId, "no-such-session", db),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("the diff DTO carries no working_dir / absolute path", async () => {
    const pkg = (await getLocalPackage(pkgId, db))!;

    await writeWorkingDirFile(pkg, "flows/leak.yaml", "name: leak\n");
    const diff = await diffWorkingDir(pkg);
    const serialized = JSON.stringify(diff);

    expect(serialized).not.toContain(pkg.workingDir);
    expect(serialized).not.toContain(homeDir);
    // file paths are working-dir-relative, never absolute
    for (const f of diff.files) expect(f.path.startsWith("/")).toBe(false);

    await discardWorkingDir(pkg);
  });
});
