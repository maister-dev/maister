import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import AdmZip from "adm-zip";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as tar from "tar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import {
  collectImportEntries,
  commitImport,
  previewImport,
} from "@/lib/local-packages/import";
import {
  acquireLock,
  assertHoldsLock,
  releaseLock,
} from "@/lib/local-packages/lock";
import {
  createLocalPackage,
  deleteLocalPackage,
  listFiles,
  type LocalPackageFileMeta,
} from "@/lib/local-packages/service";

// FIXME(any): dual drizzle peer-dep variants (matches service.integration.test.ts).
const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schemaModule>;
let homeDir: string;
let originalHome: string | undefined;
let userId: string;

// A small binary blob with a NUL and high bytes — proves bytes round-trip exact.
const BINARY = new Uint8Array([0x00, 0x01, 0xff, 0x10, 0x7f, 0x80]);

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("lpimport_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema: schemaModule });
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = await mkdtemp(join(tmpdir(), "lp-import-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  userId = randomUUID();
  await db
    .insert(schema.users)
    .values({ id: userId, email: `u-${userId}@x.test`, name: "Import Author" });
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await pool?.end();
  await container?.stop();
  await rm(homeDir, { recursive: true, force: true });
});

async function freshPkg(name: string) {
  return createLocalPackage({ name, createdBy: userId, db });
}

// Working-dir file paths that did NOT exist at scaffold time (proves nothing
// from a rejected import leaked).
async function nonScaffoldPaths(pkg: {
  workingDir: string;
}): Promise<string[]> {
  const names = await readdir(pkg.workingDir, {
    recursive: true,
    encoding: "utf8",
  });

  return names
    .map((n) => n.split(/[\\/]/).join("/"))
    .filter((n) => n.startsWith("imported"));
}

// Stage files to a tmp dir, then create a gzipped tar from it (round-trips
// through the real tar format the import lib will parse back).
async function buildTarGz(
  files: { name: string; bytes: Uint8Array }[],
): Promise<Buffer> {
  const src = await mkdtemp(join(tmpdir(), "lp-import-tarsrc-"));

  for (const f of files) {
    const abs = join(src, f.name);

    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.bytes);
  }
  const out = join(tmpdir(), `lp-import-${randomUUID()}.tgz`);

  await tar.create({ gzip: true, file: out, cwd: src }, ["."]);
  const buf = await readFile(out);

  await rm(src, { recursive: true, force: true });
  await rm(out, { force: true });

  return buf;
}

function hasFile(files: LocalPackageFileMeta[], p: string): boolean {
  return files.some((f) => f.path === p);
}

describe("local-package batch import (integration)", () => {
  it("folder import preserves subfolders + binary bytes", async () => {
    const pkg = await freshPkg("Folder Import Pack");
    const lock = await acquireLock(pkg.id, userId, "s-folder", db);

    expect(lock.heldByMe).toBe(true);

    const collected = await collectImportEntries({
      kind: "folder",
      files: [
        {
          relativePath: "imported/flows/a/flow.yaml",
          bytes: new TextEncoder().encode("name: a\n"),
        },
        { relativePath: "imported/bin.dat", bytes: BINARY },
      ],
    });

    expect(collected.source).toBe("folder");
    const plan = await commitImport(pkg, collected.entries);

    expect(plan.files.map((f) => f.path)).toEqual([
      "imported/bin.dat",
      "imported/flows/a/flow.yaml",
    ]);

    const files = await listFiles(pkg);

    expect(hasFile(files, "imported/flows/a/flow.yaml")).toBe(true);

    const wrote = await readFile(join(pkg.workingDir, "imported", "bin.dat"));

    expect(new Uint8Array(wrote)).toEqual(BINARY);

    await releaseLock(pkg.id, "s-folder", db);
    await deleteLocalPackage(pkg.id, db);
  });

  it("zip and tar.gz extract the identical tree (parity)", async () => {
    const members = [
      {
        name: "imported/skills/s.md",
        bytes: new TextEncoder().encode("# skill\n"),
      },
      { name: "imported/data/bin.dat", bytes: BINARY },
    ];

    // zip
    const zip = new AdmZip();

    for (const m of members) zip.addFile(m.name, Buffer.from(m.bytes));
    const zipBuf = zip.toBuffer();

    const zipPkg = await freshPkg("Zip Pack");

    await acquireLock(zipPkg.id, userId, "s-zip", db);
    const zipCollected = await collectImportEntries({
      kind: "archive",
      fileName: "bundle.zip",
      bytes: new Uint8Array(zipBuf),
    });

    expect(zipCollected.source).toBe("zip");
    const zipPlan = await commitImport(zipPkg, zipCollected.entries);

    // tar.gz
    const tgzBuf = await buildTarGz(members);
    const tgzPkg = await freshPkg("Tar Pack");

    await acquireLock(tgzPkg.id, userId, "s-tgz", db);
    const tgzCollected = await collectImportEntries({
      kind: "archive",
      fileName: "bundle.tar.gz",
      bytes: new Uint8Array(tgzBuf),
    });

    expect(tgzCollected.source).toBe("tar.gz");
    const tgzPlan = await commitImport(tgzPkg, tgzCollected.entries);

    // identical resolved trees
    expect(zipPlan.files.map((f) => f.path)).toEqual([
      "imported/data/bin.dat",
      "imported/skills/s.md",
    ]);
    expect(tgzPlan.files.map((f) => f.path)).toEqual(
      zipPlan.files.map((f) => f.path),
    );

    // identical binary bytes from both
    for (const root of [zipPkg, tgzPkg]) {
      const wrote = await readFile(
        join(root.workingDir, "imported", "data", "bin.dat"),
      );

      expect(new Uint8Array(wrote)).toEqual(BINARY);
    }

    await releaseLock(zipPkg.id, "s-zip", db);
    await releaseLock(tgzPkg.id, "s-tgz", db);
    await deleteLocalPackage(zipPkg.id, db);
    await deleteLocalPackage(tgzPkg.id, db);
  });

  it("zip-slip (../escape) is rejected pre-write — nothing persisted", async () => {
    const pkg = await freshPkg("Slip Zip Pack");

    await acquireLock(pkg.id, userId, "s-slip", db);

    // adm-zip's addFile() sanitizes `..` away — a REAL malicious zip is built
    // by a non-adm-zip tool. Reproduce it by mutating entryName post-add so the
    // archive on disk carries the escaping name (the read path returns it raw,
    // which is exactly why we must guard the member name ourselves).
    const zip = new AdmZip();

    zip.addFile("imported/ok.txt", Buffer.from("ok"));
    zip.addFile("placeholder.txt", Buffer.from("pwned"));
    zip.getEntries()[1].entryName = "../escape.txt";
    const collected = await collectImportEntries({
      kind: "archive",
      fileName: "evil.zip",
      bytes: new Uint8Array(zip.toBuffer()),
    });

    expect(collected.entries.some((e) => e.path.includes(".."))).toBe(true);
    await expect(commitImport(pkg, collected.entries)).rejects.toMatchObject({
      code: "PRECONDITION",
    });
    // Even the legitimate sibling member must NOT have been written.
    expect(await nonScaffoldPaths(pkg)).toEqual([]);

    await releaseLock(pkg.id, "s-slip", db);
    await deleteLocalPackage(pkg.id, db);
  });

  it("collapsing traversal (schemas/../setup.sh) is rejected on ORIGINAL segments", async () => {
    const pkg = await freshPkg("Collapse Pack");

    await acquireLock(pkg.id, userId, "s-collapse", db);
    const collected = await collectImportEntries({
      kind: "folder",
      files: [
        {
          relativePath: "schemas/../setup.sh",
          bytes: new TextEncoder().encode("#!/bin/sh\n"),
        },
      ],
    });

    await expect(commitImport(pkg, collected.entries)).rejects.toMatchObject({
      code: "PRECONDITION",
    });
    expect(await nonScaffoldPaths(pkg)).toEqual([]);
    // setup.sh (the collapse target) must not exist at the root either
    expect(hasFile(await listFiles(pkg), "setup.sh")).toBe(false);

    await releaseLock(pkg.id, "s-collapse", db);
    await deleteLocalPackage(pkg.id, db);
  });

  it("absolute and .git/ entries are rejected pre-write", async () => {
    const pkg = await freshPkg("Abs Git Pack");

    await acquireLock(pkg.id, userId, "s-absgit", db);

    for (const bad of ["/etc/passwd", ".git/config"]) {
      const collected = await collectImportEntries({
        kind: "folder",
        files: [{ relativePath: bad, bytes: new TextEncoder().encode("x") }],
      });

      await expect(commitImport(pkg, collected.entries)).rejects.toMatchObject({
        code: "PRECONDITION",
      });
    }
    expect(await nonScaffoldPaths(pkg)).toEqual([]);

    await releaseLock(pkg.id, "s-absgit", db);
    await deleteLocalPackage(pkg.id, db);
  });

  it("Windows ..\\ traversal is rejected pre-write", async () => {
    const pkg = await freshPkg("Win Slip Pack");

    await acquireLock(pkg.id, userId, "s-win", db);
    const collected = await collectImportEntries({
      kind: "folder",
      files: [
        {
          relativePath: "imported\\..\\..\\escape.txt",
          bytes: new TextEncoder().encode("x"),
        },
      ],
    });

    await expect(commitImport(pkg, collected.entries)).rejects.toMatchObject({
      code: "PRECONDITION",
    });
    expect(await nonScaffoldPaths(pkg)).toEqual([]);

    await releaseLock(pkg.id, "s-win", db);
    await deleteLocalPackage(pkg.id, db);
  });

  it("over-cap (entries) is rejected pre-write — nothing persisted", async () => {
    process.env.MAISTER_IMPORT_MAX_ENTRIES = "3";
    try {
      const pkg = await freshPkg("Too Many Pack");

      await acquireLock(pkg.id, userId, "s-many", db);
      const files = Array.from({ length: 4 }, (_, i) => ({
        relativePath: `imported/f${i}.txt`,
        bytes: new TextEncoder().encode("x"),
      }));
      const collected = await collectImportEntries({ kind: "folder", files });

      await expect(commitImport(pkg, collected.entries)).rejects.toMatchObject({
        code: "PRECONDITION",
      });
      expect(await nonScaffoldPaths(pkg)).toEqual([]);

      await releaseLock(pkg.id, "s-many", db);
      await deleteLocalPackage(pkg.id, db);
    } finally {
      delete process.env.MAISTER_IMPORT_MAX_ENTRIES;
    }
  });

  it("over-cap (single file bytes) is rejected pre-write", async () => {
    process.env.MAISTER_IMPORT_MAX_FILE_BYTES = "4";
    try {
      const pkg = await freshPkg("Big File Pack");

      await acquireLock(pkg.id, userId, "s-bigfile", db);
      const collected = await collectImportEntries({
        kind: "folder",
        files: [
          {
            relativePath: "imported/big.bin",
            bytes: new Uint8Array(16),
          },
        ],
      });

      await expect(commitImport(pkg, collected.entries)).rejects.toMatchObject({
        code: "PRECONDITION",
      });
      expect(await nonScaffoldPaths(pkg)).toEqual([]);

      await releaseLock(pkg.id, "s-bigfile", db);
      await deleteLocalPackage(pkg.id, db);
    } finally {
      delete process.env.MAISTER_IMPORT_MAX_FILE_BYTES;
    }
  });

  it("over-cap (total bytes) is rejected pre-write", async () => {
    process.env.MAISTER_IMPORT_MAX_BYTES = "10";
    try {
      const pkg = await freshPkg("Big Total Pack");

      await acquireLock(pkg.id, userId, "s-bigtotal", db);
      const collected = await collectImportEntries({
        kind: "folder",
        files: [
          { relativePath: "imported/a.bin", bytes: new Uint8Array(6) },
          { relativePath: "imported/b.bin", bytes: new Uint8Array(6) },
        ],
      });

      await expect(commitImport(pkg, collected.entries)).rejects.toMatchObject({
        code: "PRECONDITION",
      });
      expect(await nonScaffoldPaths(pkg)).toEqual([]);

      await releaseLock(pkg.id, "s-bigtotal", db);
      await deleteLocalPackage(pkg.id, db);
    } finally {
      delete process.env.MAISTER_IMPORT_MAX_BYTES;
    }
  });

  it("preview resolves the tree WITHOUT writing", async () => {
    const pkg = await freshPkg("Preview Pack");
    // Note: NO lock acquired — preview needs none.
    const collected = await collectImportEntries({
      kind: "folder",
      files: [
        {
          relativePath: "imported/p.txt",
          bytes: new TextEncoder().encode("preview"),
        },
      ],
    });
    const plan = await previewImport(pkg, collected.entries);

    expect(plan.files).toEqual([{ path: "imported/p.txt", size: 7 }]);
    expect(plan.totalBytes).toBe(7);
    // nothing written
    expect(await nonScaffoldPaths(pkg)).toEqual([]);

    await deleteLocalPackage(pkg.id, db);
  });

  it("commit gate: assertHoldsLock rejects with CONFLICT when no live lock", async () => {
    // The route asserts the session edit-lock before commitImport writes; with
    // no lock held the gate throws CONFLICT (commit is blocked).
    const pkg = await freshPkg("No Lock Pack");

    await expect(
      assertHoldsLock(pkg.id, "no-such-session", db),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await deleteLocalPackage(pkg.id, db);
  });
});
