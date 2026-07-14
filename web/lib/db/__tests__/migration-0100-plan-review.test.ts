import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  __dirname,
  "../migrations/0100_mighty_big_bertha.sql",
);

describe("migration 0100 plan-review decision requests", () => {
  it("adds provenance FKs, deduplicates children, and constrains the kind shape", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain('ADD COLUMN "parent_hitl_request_id" text');
    expect(sql).toContain('ADD COLUMN "source_artifact_id" text');
    expect(sql).toContain('ADD COLUMN "decision_id" text');
    expect(sql).toContain("hitl_requests_parent_hitl_request_id_hitl_requests_id_fk");
    expect(sql).toContain("hitl_requests_source_artifact_id_artifact_instances_id_fk");
    expect(sql).toContain("hitl_requests_decision_request_uq");
    expect(sql).toContain("hitl_requests_decision_request_shape_check");
  });
});
