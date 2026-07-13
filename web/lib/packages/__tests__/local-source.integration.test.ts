import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import {
  createPackageSource,
  refreshPackageSource,
} from "@/lib/packages/catalog";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-132 §c: a `kind: 'local'` source's refresh is a directory walk +
// re-digest (no git) — digest-as-version. The digest label changes when a
// file changes and is STABLE when nothing changed (idempotent re-check).

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schemaModule>;

const MANIFEST = (name: string): string =>
  `schemaVersion: 1\nname: ${name}\nflows:\n  - { id: f1, path: flows/f1 }\ncapabilities: []\n`;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "localsource_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("kind:local source discovery (integration, real Postgres)", () => {
  it("registers → discovers with digest labels; re-check is idempotent and mutation flips the digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-src-"));

    try {
      await mkdir(join(root, "packages/aif/flows/f1"), { recursive: true });
      await writeFile(
        join(root, "packages/aif/maister-package.yaml"),
        MANIFEST("aif"),
      );
      await writeFile(
        join(root, "packages/aif/flows/f1/flow.yaml"),
        "schemaVersion: 1\nname: f1\n",
      );

      const { id } = await createPackageSource({
        url: root,
        kind: "local",
        db,
      });
      const [row] = await db
        .select()
        .from(schema.packageSources)
        .where(eq(schema.packageSources.id, id));

      expect(row.kind).toBe("local");

      const first = await refreshPackageSource({ id, db });

      expect(first?.degraded).toBe(false);
      expect(first?.packages).toHaveLength(1);
      expect(first?.packages[0]).toMatchObject({
        name: "aif",
        dir: "aif",
        tags: [],
      });
      const label1 = first?.packages[0]?.digestVersionLabel;

      expect(label1).toMatch(/^local-[0-9a-f]{12}$/);

      // Idempotent re-check: no byte change → same digest label.
      const second = await refreshPackageSource({ id, db });

      expect(second?.packages[0]?.digestVersionLabel).toBe(label1);

      // Mutation flips the digest (drift surfaces on re-check, never
      // silently).
      await writeFile(
        join(root, "packages/aif/flows/f1/flow.yaml"),
        "schemaVersion: 1\nname: f1\n# changed\n",
      );
      const third = await refreshPackageSource({ id, db });
      const label3 = third?.packages[0]?.digestVersionLabel;

      expect(label3).toMatch(/^local-[0-9a-f]{12}$/);
      expect(label3).not.toBe(label1);

      // The persisted snapshot carries the fresh label.
      const [after] = await db
        .select()
        .from(schema.packageSources)
        .where(eq(schema.packageSources.id, id));

      expect(after.discovered?.[0]?.digestVersionLabel).toBe(label3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("degrades to the stale snapshot when the directory vanishes (never blocks)", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-src-gone-"));

    await writeFile(join(root, "maister-package.yaml"), MANIFEST("solo"));
    const { id } = await createPackageSource({ url: root, kind: "local", db });
    const first = await refreshPackageSource({ id, db });

    expect(first?.degraded).toBe(false);
    await rm(root, { recursive: true, force: true });

    const second = await refreshPackageSource({ id, db });

    expect(second?.degraded).toBe(true);
    expect(second?.packages).toEqual(first?.packages);
  });
});
