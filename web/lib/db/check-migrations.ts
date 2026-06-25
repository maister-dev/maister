import "server-only";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sql, type SQL } from "drizzle-orm";

// Runtime counterpart to the journal-ordering lint in
// __tests__/migration-journal-integrity.test.ts. The lint guards the journal
// at authoring time; this guards a *live database* at boot / in CI. It answers
// one question: is every migration the journal expects actually recorded in
// drizzle.__drizzle_migrations? A "no" means db:migrate silently skipped one
// (out-of-order `when`), or was never run, or applied partially — all of which
// otherwise surface as a confusing runtime "column does not exist". The
// fresh-container integration suite cannot catch this (an empty ledger makes
// drizzle apply everything regardless of `when`), so this check is the only
// thing that flags a drifted long-lived DB.

const MIGRATIONS_DIR = join(process.cwd(), "lib/db/migrations");
const JOURNAL_PATH = join(MIGRATIONS_DIR, "meta/_journal.json");

type JournalEntry = { idx: number; tag: string; when: number };

// The caller narrows the getDb() union to the Postgres branch (which has
// `execute`) before passing — the check is Postgres-only regardless.
type MigrationCheckDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

function readJournalTags(): string[] {
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
    entries: JournalEntry[];
  };

  return journal.entries.map((e) => e.tag);
}

function migrationHash(tag: string): string {
  // drizzle's migrator records sha256 of the raw .sql file bytes as the ledger
  // `hash` (no normalization) — match it exactly so a present migration is
  // recognized as applied.
  return createHash("sha256")
    .update(readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8"))
    .digest("hex");
}

// Returns the tags of journal migrations NOT present in the DB's ledger.
// Empty array = the database is fully migrated. Postgres only — migrations run
// on Postgres (see migrate.ts); any other dialect returns [] (skip).
export async function findPendingMigrations(
  db: MigrationCheckDb,
): Promise<string[]> {
  if (!(process.env.DB_URL ?? "").startsWith("postgres")) return [];

  let applied: Set<string>;

  try {
    const result = await db.execute(
      sql`SELECT hash FROM drizzle.__drizzle_migrations`,
    );

    applied = new Set(result.rows.map((r) => String(r.hash)));
  } catch (err) {
    // 42P01 = undefined_table: the ledger doesn't exist yet, so nothing has
    // been applied. Any other error (connection, auth) is not ours to swallow.
    if ((err as { code?: string }).code === "42P01") applied = new Set();
    else throw err;
  }

  return readJournalTags().filter((tag) => !applied.has(migrationHash(tag)));
}
