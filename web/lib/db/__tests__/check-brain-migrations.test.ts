import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findPendingBrainMigrations } from "@/lib/db/check-migrations";

// T1.1 boot guard: the brain lineage has its OWN journal + ledger table, so the
// boot guard checks it independently. Postgres-only; no-ops under SQLite.

const BRAIN_DIR = join(process.cwd(), "lib/db/brain-migrations");

function brainHash(tag: string): string {
  return createHash("sha256")
    .update(readFileSync(join(BRAIN_DIR, `${tag}.sql`), "utf8"))
    .digest("hex");
}

type Rows = Array<Record<string, unknown>>;

function mockDb(onExecute: () => Rows) {
  return {
    execute: async () => ({ rows: onExecute() }),
  };
}

describe("findPendingBrainMigrations (ADR-122 boot guard)", () => {
  const original = process.env.DB_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.DB_URL;
    else process.env.DB_URL = original;
  });

  it("skips under SQLite (DB_URL=file:) and never queries the ledger", async () => {
    process.env.DB_URL = "file:./dev.db";
    let queried = false;
    const db = mockDb(() => {
      queried = true;

      return [];
    });

    expect(await findPendingBrainMigrations(db)).toEqual([]);
    expect(queried).toBe(false);
  });

  it("flags every brain migration when the ledger is absent (42P01)", async () => {
    process.env.DB_URL = "postgres://u:p@localhost:5432/db";
    const db = {
      execute: async () => {
        throw { code: "42P01" };
      },
    };

    const pending = await findPendingBrainMigrations(db);

    expect(pending).toContain("0001_brain_foundation");
  });

  it("returns [] when the brain ledger already records every migration", async () => {
    process.env.DB_URL = "postgres://u:p@localhost:5432/db";
    // The ledger must record EVERY hand-authored brain migration, derived from
    // the journal so a new migration never leaves this fixture stale.
    const journal = JSON.parse(
      readFileSync(join(BRAIN_DIR, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    const db = mockDb(() =>
      journal.entries.map((e) => ({ hash: brainHash(e.tag) })),
    );

    expect(await findPendingBrainMigrations(db)).toEqual([]);
  });
});
