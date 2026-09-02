import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RELEASED_LIFECYCLE_CLAIM } from "@/lib/runs/lifecycle-claim";

// `workspaces_lifecycle_claim_shape_check` (migration 0116) makes a lifecycle
// claim a SHAPE: for state 'none' every claim column must be NULL. A release
// that clears only some of them does not leave a half-released claim — the
// CHECK rejects the UPDATE and the release THROWS. Two of four release sites
// had drifted that way; the constant is the one release shape, and this pins
// it against the migration text so the two cannot drift apart again.

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(here, "../../db/migrations/0116_keen_talisman.sql");

function snakeCase(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

describe("RELEASED_LIFECYCLE_CLAIM", () => {
  it("resets the state to none and nulls every other claim column", () => {
    expect(RELEASED_LIFECYCLE_CLAIM.lifecycleOperationState).toBe("none");

    const nulled = Object.entries(RELEASED_LIFECYCLE_CLAIM)
      .filter(([key]) => key !== "lifecycleOperationState")
      .map(([, value]) => value);

    expect(nulled.length).toBeGreaterThan(0);
    expect(nulled.every((value) => value === null)).toBe(true);
  });

  it("clears every column the 0116 CHECK requires NULL for state 'none'", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const check = sql.slice(
      sql.indexOf("workspaces_lifecycle_claim_shape_check"),
    );
    const noneArm = check.slice(
      check.indexOf("= 'none'"),
      check.indexOf("OR", check.indexOf("= 'none'")),
    );
    const requiredNull = [
      ...noneArm.matchAll(/"(lifecycle_operation_[a-z_]+)" IS NULL/g),
    ].map((m) => m[1]);

    expect(requiredNull.length).toBeGreaterThanOrEqual(4);

    const released = Object.keys(RELEASED_LIFECYCLE_CLAIM).map(snakeCase);

    for (const column of requiredNull) {
      expect(released).toContain(column);
    }
  });
});
