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

function journalEntries(): Array<{ idx: number; tag: string }> {
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
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
});
