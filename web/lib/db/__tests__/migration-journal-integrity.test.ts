import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Guards the failure class that the M27 branch hit: an independently-numbered
// migration on another branch collides on filename/idx at merge, or a renumber
// leaves an orphan .sql / duplicate idx. drizzle's migrator resolves each
// `entry.tag` to `${tag}.sql`, so a tag without a file (or a file without an
// entry) silently breaks `migrate()`; duplicate idx/tag corrupts ordering.

const MIGRATIONS_DIR = join(__dirname, "../migrations");
const JOURNAL_PATH = join(MIGRATIONS_DIR, "meta/_journal.json");

function journalEntries(): Array<{ idx: number; tag: string; when: number }> {
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };

  return journal.entries;
}

function sqlFileTags(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""));
}

describe("migration journal ↔ files integrity", () => {
  it("every journal tag has a matching .sql file", () => {
    for (const entry of journalEntries()) {
      expect(
        existsSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`)),
        `journal tag "${entry.tag}" has no ${entry.tag}.sql`,
      ).toBe(true);
    }
  });

  it("every .sql file is registered in the journal (no orphan)", () => {
    const tags = new Set(journalEntries().map((e) => e.tag));

    for (const fileTag of sqlFileTags()) {
      expect(tags.has(fileTag), `${fileTag}.sql is not in _journal.json`).toBe(
        true,
      );
    }
  });

  it("journal idx values are unique (no collision)", () => {
    const idxs = journalEntries().map((e) => e.idx);

    expect(new Set(idxs).size).toBe(idxs.length);
  });

  it("journal tags are unique (no duplicate migration)", () => {
    const tags = journalEntries().map((e) => e.tag);

    expect(new Set(tags).size).toBe(tags.length);
  });

  // Guards the failure class that the 2026-06-25 Studio crash hit: a
  // rebase/renumber left a migration's old authoring `when` while placing it
  // after newer entries. drizzle's node-postgres migrator reads the single
  // highest `created_at` in drizzle.__drizzle_migrations once, then applies an
  // entry only when `entry.when > thatMax`. So an out-of-order (<=) `when` is
  // SILENTLY skipped on every incremental `db:migrate` against a DB already
  // past it — surfacing later as a runtime "column does not exist". Fresh
  // installs are unaffected (the empty ledger short-circuits the comparison and
  // applies all in array order), which is exactly why CI's fresh-container
  // integration suite cannot catch it. The runtime counterpart is the
  // boot/`pnpm db:check` guard in lib/db/check-migrations.ts.
  it("journal entries are ordered by strictly increasing idx", () => {
    const entries = journalEntries();

    for (let i = 1; i < entries.length; i++) {
      expect(
        entries[i].idx,
        `entry "${entries[i].tag}" (idx ${entries[i].idx}) must come after ` +
          `"${entries[i - 1].tag}" (idx ${entries[i - 1].idx}) in array order`,
      ).toBeGreaterThan(entries[i - 1].idx);
    }
  });

  it("journal `when` timestamps are strictly increasing in entry order", () => {
    const entries = journalEntries();

    for (let i = 1; i < entries.length; i++) {
      expect(
        entries[i].when,
        `"${entries[i].tag}" (when=${entries[i].when}) must have a strictly ` +
          `greater \`when\` than "${entries[i - 1].tag}" ` +
          `(when=${entries[i - 1].when}); equal or lower values get skipped by ` +
          `incremental db:migrate — bump the new migration's \`when\` above all ` +
          `prior entries (renumber it to the end if a rebase landed it early)`,
      ).toBeGreaterThan(entries[i - 1].when);
    }
  });
});
