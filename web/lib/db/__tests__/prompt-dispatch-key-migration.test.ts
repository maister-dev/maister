// TRC-12: a run created before this change is not modified.
//
// D3 states the consequence plainly — runs that predate this work keep their
// wall of projector `log` artifacts, and nothing is built to clean them up. A
// read-side filter remains available later; it is not written now because it
// would be the only line that does not trace to "new runs must be clean".
//
// That is only a decision if it is enforced. This is the contract test that
// stops the cheapest way to break it: a backfill, a sweep, or a cutoff
// predicate slipped into the one migration this work ships.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATION = join(__dirname, "../migrations/0170_prompt_dispatch_key.sql");

function statements(): string[] {
  return readFileSync(MIGRATION, "utf8")
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        // `-->` lines are drizzle's breakpoint markers and this file's own
        // prose; neither is DDL.
        .filter((line) => !line.trimStart().startsWith("-->"))
        .join("\n")
        .trim(),
    )
    .filter((chunk) => chunk.length > 0);
}

describe("CT-TRC-12: the prompt_dispatch_key migration leaves prior runs alone", () => {
  it("CT-TRC-12: adds a nullable column and an index, and nothing else", async () => {
    const ddl = statements();

    expect(ddl).toHaveLength(2);
    expect(ddl[0]).toMatch(
      /^ALTER TABLE "run_messages" ADD COLUMN "prompt_dispatch_key" text;$/,
    );
    expect(ddl[1]).toMatch(/^CREATE UNIQUE INDEX/);

    // The column is nullable with no DEFAULT: every existing row keeps NULL,
    // so no rewrite of the table is implied and no prior row joins the index.
    expect(ddl[0]).not.toMatch(/NOT NULL|DEFAULT/i);
  });

  it("CT-TRC-12: contains no backfill, sweep, or retention change", async () => {
    const sql = statements().join("\n").toUpperCase();

    for (const forbidden of [
      "UPDATE ",
      "DELETE ",
      "INSERT ",
      "TRUNCATE",
      "DROP TABLE",
      "DROP COLUMN",
    ]) {
      expect(sql).not.toContain(forbidden);
    }
  });

  // The index must not carry a date/id cutoff: a predicate that excluded old
  // rows would be a read-side history filter wearing a schema disguise, and
  // EDGE-TRC-03 depends on the predicate being exactly this one.
  it("CT-TRC-12: scopes the index by dispatch key alone, not by any cutoff", async () => {
    const [, index] = statements();
    const where = index.slice(index.toUpperCase().indexOf(" WHERE "));

    expect(where.trim()).toBe(
      'WHERE "run_messages"."prompt_dispatch_key" IS NOT NULL;',
    );
    expect(index).toContain("NULLS NOT DISTINCT");
  });
});
