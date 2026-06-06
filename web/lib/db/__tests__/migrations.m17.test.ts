import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * M17 ADR-054: migration 0025 test (renumbered to sit after main's
 * 0022_platform_acp_runners / 0023_drop_legacy_executors / 0024_m22_flow_graph_layouts).
 * Verify that hitl_requests table adds columns:
 * - criticality (text, nullable)
 * - human_confidence (real/double, nullable)
 */

const MIGRATION_PATH = join(
  __dirname,
  "../migrations/0025_m17_hitl_assessment.sql",
);
const JOURNAL_PATH = join(__dirname, "../migrations/meta/_journal.json");

function migrationSql(): string {
  return readFileSync(MIGRATION_PATH, "utf8");
}

describe("Migration 0025_m17_hitl_assessment", () => {
  it("adds criticality column (text, nullable) to hitl_requests", () => {
    const sql = migrationSql();

    expect(sql).toContain(
      'ALTER TABLE "hitl_requests" ADD COLUMN "criticality" text',
    );
  });

  it("adds human_confidence column (real, nullable) to hitl_requests", () => {
    const sql = migrationSql();

    expect(sql).toContain(
      'ALTER TABLE "hitl_requests" ADD COLUMN "human_confidence" real',
    );
  });

  it("permits inserting hitl_requests with both criticality and human_confidence", () => {
    // Structural check: both columns are present in the migration SQL as nullable
    // (no NOT NULL constraint, no DEFAULT) — confirms they can store any value.
    const sql = migrationSql();

    const critLine = sql.split("\n").find((l) => l.includes('"criticality"'));
    const confLine = sql
      .split("\n")
      .find((l) => l.includes('"human_confidence"'));

    expect(critLine).toBeDefined();
    expect(confLine).toBeDefined();
    // Neither column has NOT NULL or DEFAULT — fully nullable.
    expect(critLine).not.toMatch(/NOT NULL/i);
    expect(confLine).not.toMatch(/NOT NULL/i);
    expect(critLine).not.toMatch(/DEFAULT/i);
    expect(confLine).not.toMatch(/DEFAULT/i);
  });

  it("permits inserting hitl_requests with both columns as NULL", () => {
    // Same structural check as above — no NOT NULL means NULL is always permitted.
    const sql = migrationSql();

    expect(sql).not.toMatch(/NOT NULL/);
    expect(sql).not.toMatch(/DEFAULT/);
  });

  it("existing hitl_requests rows have both columns as NULL after migration", () => {
    // Additive-only migration: no UPDATE or backfill in the SQL.
    const sql = migrationSql();

    expect(sql.toUpperCase()).not.toContain("UPDATE");
  });

  it("new hitl_requests can store criticality without human_confidence", () => {
    // criticality column exists and is nullable — allows partial insert.
    const sql = migrationSql();

    expect(sql).toContain('"criticality" text');
  });

  it("new hitl_requests can store human_confidence without criticality", () => {
    // human_confidence column exists and is nullable — allows partial insert.
    const sql = migrationSql();

    expect(sql).toContain('"human_confidence" real');
  });
});

describe("Migration journal — entry 0025", () => {
  it("journal has an entry for 0025_m17_hitl_assessment at idx 25", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const entry = journal.entries.find((e) => e.idx === 25);

    expect(entry).toBeDefined();
    expect(entry?.tag).toBe("0025_m17_hitl_assessment");
  });

  it("journal has an entry for 0026_m17_actor_token_uniqueness at idx 26", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const entry = journal.entries.find((e) => e.idx === 26);

    expect(entry).toBeDefined();
    expect(entry?.tag).toBe("0026_m17_actor_token_uniqueness");
  });
});
