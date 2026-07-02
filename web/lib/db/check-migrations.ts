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
// `findPendingBrainMigrations`. Both lineages are Postgres-only; the brain
// check additionally no-ops when the brain lineage is not provisioned in this
// checkout (its journal file is absent).

const MAIN_MIGRATIONS_DIR = join(process.cwd(), "lib/db/migrations");
const BRAIN_MIGRATIONS_DIR = join(process.cwd(), "lib/db/brain-migrations");

type JournalEntry = { idx: number; tag: string; when: number };

// The caller narrows the getDb() union to the Postgres branch (which has
// `execute`) before passing — the check is Postgres-only regardless.
type MigrationCheckDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

function isPostgres(): boolean {
  return (process.env.DB_URL ?? "").startsWith("postgres");
}

function readJournalTags(dir: string): string[] {
  const journal = JSON.parse(
    readFileSync(join(dir, "meta/_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };

  return journal.entries.map((e) => e.tag);
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
// by `ledgerQuery`. Empty = fully migrated. Postgres only (caller guards).
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
// ledger. Empty array = the database is fully migrated. Postgres only.
export async function findPendingMigrations(
  db: MigrationCheckDb,
): Promise<string[]> {
  if (!isPostgres()) return [];

  return collectPending(
    db,
    MAIN_MIGRATIONS_DIR,
    sql`SELECT hash FROM drizzle.__drizzle_migrations`,
  );
}

// ADR-122: the BRAIN-lineage counterpart, reading the brain journal against the
// brain ledger table. No-ops under SQLite (Brain disabled, D3) and when the
// brain lineage is not provisioned in this checkout (journal file absent).
export async function findPendingBrainMigrations(
  db: MigrationCheckDb,
): Promise<string[]> {
  if (!isPostgres()) return [];
  if (!existsSync(join(BRAIN_MIGRATIONS_DIR, "meta/_journal.json"))) return [];

  return collectPending(
    db,
    BRAIN_MIGRATIONS_DIR,
    sql`SELECT hash FROM drizzle.__drizzle_brain_migrations`,
  );
}
