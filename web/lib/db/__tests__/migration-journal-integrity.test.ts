import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Guards the failure class that the M27 branch hit: an independently-numbered
// migration on another branch collides on filename/idx at merge, or a renumber
// leaves an orphan .sql / duplicate idx. drizzle's migrator resolves each
// `entry.tag` to `${tag}.sql`, so a tag without a file (or a file without an
// entry) silently breaks `migrate()`; duplicate idx/tag corrupts ordering.
//
// Covers BOTH lineages: the main drizzle-kit lineage AND the hand-authored
// ADR-122 brain lineage (`brain-migrations/`) — hand-authored journals are the
// MOST exposed to a non-monotonic `when` (nothing generates them).

const MAIN_MIGRATIONS_DIR = join(__dirname, "../migrations");

const LINEAGES = [
  { name: "main", dir: MAIN_MIGRATIONS_DIR },
  { name: "brain", dir: join(__dirname, "../brain-migrations") },
] as const;

function journalEntries(
  dir: string,
): Array<{ idx: number; tag: string; when: number }> {
  const journal = JSON.parse(
    readFileSync(join(dir, "meta/_journal.json"), "utf8"),
  ) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };

  return journal.entries;
}

function sqlFileTags(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""));
}

describe.each(LINEAGES)(
  "$name migration journal ↔ files integrity",
  ({ dir }) => {
    it("every journal tag has a matching .sql file", () => {
      for (const entry of journalEntries(dir)) {
        expect(
          existsSync(join(dir, `${entry.tag}.sql`)),
          `journal tag "${entry.tag}" has no ${entry.tag}.sql`,
        ).toBe(true);
      }
    });

    it("every .sql file is registered in the journal (no orphan)", () => {
      const tags = new Set(journalEntries(dir).map((e) => e.tag));

      for (const fileTag of sqlFileTags(dir)) {
        expect(
          tags.has(fileTag),
          `${fileTag}.sql is not in _journal.json`,
        ).toBe(true);
      }
    });

    it("journal idx values are unique (no collision)", () => {
      const idxs = journalEntries(dir).map((e) => e.idx);

      expect(new Set(idxs).size).toBe(idxs.length);
    });

    it("journal tags are unique (no duplicate migration)", () => {
      const tags = journalEntries(dir).map((e) => e.tag);

      expect(new Set(tags).size).toBe(tags.length);
    });

    // Guards the failure class that the 2026-06-25 Studio crash hit: a
    // rebase/renumber left a migration's old authoring `when` while placing it
    // after newer entries. drizzle's node-postgres migrator reads the single
    // highest `created_at` in the ledger once, then applies an entry only when
    // `entry.when > thatMax`. So an out-of-order (<=) `when` is SILENTLY
    // skipped on every incremental migrate against a DB already past it —
    // surfacing later as a runtime "column does not exist". Fresh installs are
    // unaffected (the empty ledger short-circuits the comparison and applies
    // all in array order), which is exactly why CI's fresh-container
    // integration suite cannot catch it. The runtime counterpart is the
    // boot/`pnpm db:check` guard in lib/db/check-migrations.ts.
    it("journal entries are ordered by strictly increasing idx", () => {
      const entries = journalEntries(dir);

      for (let i = 1; i < entries.length; i++) {
        expect(
          entries[i].idx,
          `entry "${entries[i].tag}" (idx ${entries[i].idx}) must come after ` +
            `"${entries[i - 1].tag}" (idx ${entries[i - 1].idx}) in array order`,
        ).toBeGreaterThan(entries[i - 1].idx);
      }
    });

    it("journal `when` timestamps are strictly increasing in entry order", () => {
      const entries = journalEntries(dir);

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

    // A hand-authored `when` in the FUTURE makes every migration authored with
    // Date.now() before that instant non-monotonic (silently skipped, above).
    // Allow a small clock-skew margin only.
    it("journal `when` timestamps are not in the future", () => {
      const margin = 5 * 60 * 1000;
      const now = Date.now();

      for (const entry of journalEntries(dir)) {
        expect(
          entry.when,
          `"${entry.tag}" has a future-dated \`when\` (${new Date(entry.when).toISOString()}) — ` +
            `a later migration authored with Date.now() would be silently skipped`,
        ).toBeLessThanOrEqual(now + margin);
      }
    });
  },
);

describe("main migration snapshot integrity", () => {
  it("newest journal entry has a matching Drizzle snapshot", () => {
    const newest = journalEntries(MAIN_MIGRATIONS_DIR).at(-1);

    expect(newest, "main migration journal must have entries").toBeDefined();

    if (!newest) {
      return;
    }

    const prefix = newest.tag.slice(0, 4);
    const snapshotPath = join(
      MAIN_MIGRATIONS_DIR,
      "meta",
      `${prefix}_snapshot.json`,
    );

    expect(
      prefix,
      `journal tag "${newest.tag}" must start with 4 digits`,
    ).toMatch(/^\d{4}$/);
    expect(
      existsSync(snapshotPath),
      `newest journal tag "${newest.tag}" has no meta/${prefix}_snapshot.json; ` +
        "run pnpm --filter maister-web db:generate or restore the generated snapshot",
    ).toBe(true);
  });

  it("registers the canonical Create Flow migration", () => {
    const migration = journalEntries(MAIN_MIGRATIONS_DIR).find((entry) =>
      /^0115_/.test(entry.tag),
    );

    expect(migration, "0115 must be registered").toBeDefined();
    expect(
      migration &&
        existsSync(join(MAIN_MIGRATIONS_DIR, `${migration.tag}.sql`)),
      "0115 must register the local-package creation-state SQL migration",
    ).toBe(true);
  });

  it("registers the ADR-148 lifecycle-result migration", () => {
    const migration = journalEntries(MAIN_MIGRATIONS_DIR).find(
      (entry) => entry.tag === "0116_keen_talisman",
    );

    if (!migration) {
      throw new Error("expected ADR-148 lifecycle migration");
    }

    expect(existsSync(join(MAIN_MIGRATIONS_DIR, `${migration.tag}.sql`))).toBe(
      true,
    );
  });

  it("backfills only removed workspaces as legacy lifecycle results", () => {
    const migration = readFileSync(
      join(MAIN_MIGRATIONS_DIR, "0116_keen_talisman.sql"),
      "utf8",
    );

    expect(migration).toContain("\"removal_kind\" = 'legacy'");
    expect(migration).toContain("\"preservation_outcome\" = 'legacy_unknown'");
    expect(migration).toContain('WHERE "removed_at" IS NOT NULL');
    expect(migration).toContain('"workspaces_lifecycle_claim_shape_check"');
    expect(migration).toContain('"workspaces_removed_result_check"');
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "workspace_reconciliation_findings"',
    );
  });

  it("registers the follow-up reconciliation integrity checks", () => {
    const integrityMigration = journalEntries(MAIN_MIGRATIONS_DIR).find(
      (entry) => entry.tag === "0117_new_maggott",
    );

    if (!integrityMigration) {
      throw new Error("expected ADR-148 reconciliation integrity migration");
    }

    const migration = readFileSync(
      join(MAIN_MIGRATIONS_DIR, `${integrityMigration.tag}.sql`),
      "utf8",
    );

    expect(migration).toContain(
      '"workspace_reconciliation_findings_attempt_count_check"',
    );
    expect(migration).toContain(
      '"workspace_reconciliation_findings_resolved_shape_check"',
    );
  });
});
