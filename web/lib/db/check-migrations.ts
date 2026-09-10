import "server-only";

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sql, type SQL } from "drizzle-orm";

// Runtime counterpart to the journal-ordering lint in
// __tests__/migration-journal-integrity.test.ts. The lint guards the journal
// at authoring time; this guards a *live database* at boot / in CI. It answers
// one question: is every migration the journal expects actually recorded in the
// matching drizzle ledger? A "no" means db:migrate silently skipped one
// (out-of-order `when`), or was never run, or applied partially — all of which
// otherwise surface as a confusing runtime "column does not exist". The
// fresh-container integration suite cannot catch this (an empty ledger makes
// drizzle apply everything regardless of `when`), so this check is the only
// thing that flags a drifted long-lived DB.
//
// ADR-122: the Project Brain lineage is a SEPARATE folder + a SEPARATE ledger
// table (`drizzle.__drizzle_brain_migrations`), so it needs its own check —
// `findPendingBrainMigrations`. The brain check additionally no-ops when the
// brain lineage is not provisioned in this checkout (its journal file is
// absent).

const MAIN_MIGRATIONS_DIR = join(process.cwd(), "lib/db/migrations");
const BRAIN_MIGRATIONS_DIR = join(process.cwd(), "lib/db/brain-migrations");

export type JournalEntry = { idx: number; tag: string; when: number };

type MigrationCheckDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

function readJournalTags(dir: string): string[] {
  const journal = JSON.parse(
    readFileSync(join(dir, "meta/_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };

  return journal.entries.map((e) => e.tag);
}

export function findMainMigrationJournalEntry(
  tag: string,
): JournalEntry | null {
  return readMainMigrationJournal().find((entry) => entry.tag === tag) ?? null;
}

export function readMainMigrationJournal(): JournalEntry[] {
  const journal = JSON.parse(
    readFileSync(join(MAIN_MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };

  return journal.entries;
}

// The ledger hash drizzle records for a main-lineage migration, so operator
// tooling can report exactly which committed migration bytes a stage applies.
export function mainMigrationHash(tag: string): string {
  return migrationHash(MAIN_MIGRATIONS_DIR, tag);
}

function migrationHash(dir: string, tag: string): string {
  // drizzle's migrator records sha256 of the raw .sql file bytes as the ledger
  // `hash` (no normalization) — match it exactly so a present migration is
  // recognized as applied.
  return createHash("sha256")
    .update(readFileSync(join(dir, `${tag}.sql`), "utf8"))
    .digest("hex");
}

// Shared core: return the journal tags in `dir` NOT present in the ledger read
// by `ledgerQuery`. Empty = fully migrated.
async function collectPending(
  db: MigrationCheckDb,
  dir: string,
  ledgerQuery: SQL,
): Promise<string[]> {
  let applied: Set<string>;

  try {
    const result = await db.execute(ledgerQuery);

    applied = new Set(result.rows.map((r) => String(r.hash)));
  } catch (err) {
    // 42P01 = undefined_table: the ledger doesn't exist yet, so nothing has
    // been applied. Any other error (connection, auth) is not ours to swallow.
    if ((err as { code?: string }).code === "42P01") applied = new Set();
    else throw err;
  }

  return readJournalTags(dir).filter(
    (tag) => !applied.has(migrationHash(dir, tag)),
  );
}

// Returns the tags of MAIN-lineage journal migrations NOT present in the DB's
// ledger. Empty array = the database is fully migrated.
export async function findPendingMigrations(
  db: MigrationCheckDb,
): Promise<string[]> {
  return collectPending(
    db,
    MAIN_MIGRATIONS_DIR,
    sql`SELECT hash FROM drizzle.__drizzle_migrations`,
  );
}

// Drizzle's incremental migrator compares journal `when` against the ledger's
// high-water `created_at`. A hash-missing migration at or below that watermark
// is silently skipped, so callers that need an irreversible pre-migration read
// must reject the drift rather than report a false successful transition.
export async function mainMigrationLedgerHighWater(
  db: MigrationCheckDb,
): Promise<number | null> {
  try {
    const result = await db.execute(
      sql`SELECT MAX(created_at) AS "createdAt" FROM drizzle.__drizzle_migrations`,
    );
    const value = result.rows[0]?.createdAt;
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : NaN;

    return Number.isFinite(parsed) ? parsed : null;
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return null;
    throw err;
  }
}

// ADR-122: the BRAIN-lineage counterpart, reading the brain journal against the
// brain ledger table. No-ops when the brain lineage is not provisioned in this
// checkout (journal file absent).
export async function findPendingBrainMigrations(
  db: MigrationCheckDb,
): Promise<string[]> {
  if (!existsSync(join(BRAIN_MIGRATIONS_DIR, "meta/_journal.json"))) return [];

  return collectPending(
    db,
    BRAIN_MIGRATIONS_DIR,
    sql`SELECT hash FROM drizzle.__drizzle_brain_migrations`,
  );
}
