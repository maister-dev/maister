import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  RELEASED_LIFECYCLE_CLAIM,
  workbenchClaimHolder,
  workbenchClaimHoldsTree,
} from "@/lib/runs/lifecycle-claim";

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

// ADR-181 C26: the one rule for "a live workbench claim owns the tree", which
// the git facts (`busy`) and both recovers read — so none can disagree.
describe("workbenchClaimHolder", () => {
  const now = Date.now();
  const recent = new Date(now - 1_000);
  const leaseAhead = new Date(now + 60_000);
  const leaseLapsed = new Date(now - 1_000);

  it("names a lifecycle operation inside its lease", () => {
    const workspace = {
      lifecycleOperationState: "claiming",
      lifecycleOperationName: "exportBranch",
      lifecycleOperationClaimedAt: recent,
      lifecycleOperationLeaseExpiresAt: leaseAhead,
    };

    expect(workbenchClaimHolder(workspace)).toEqual({
      name: "exportBranch",
      claimedAt: recent,
    });
    expect(workbenchClaimHoldsTree(workspace)).toBe(true);
  });

  it("names a promotion inside its window when no lifecycle operation holds", () => {
    const workspace = {
      lifecycleOperationState: "claiming",
      lifecycleOperationName: "sync",
      lifecycleOperationLeaseExpiresAt: leaseLapsed,
      promotionState: "claiming",
      promotionClaimedAt: recent,
    };

    expect(workbenchClaimHolder(workspace)).toEqual({
      name: "promotion",
      claimedAt: recent,
    });
    expect(workbenchClaimHoldsTree(workspace)).toBe(true);
  });

  it("answers null for a free slot, a lapsed lease and a stale promotion", () => {
    const workspace = {
      lifecycleOperationState: "claiming",
      lifecycleOperationName: "sync",
      lifecycleOperationLeaseExpiresAt: leaseLapsed,
      promotionState: "claiming",
      promotionClaimedAt: new Date(0),
    };

    expect(workbenchClaimHolder({})).toBeNull();
    expect(workbenchClaimHolder(workspace)).toBeNull();
    expect(workbenchClaimHoldsTree(workspace)).toBe(false);
  });

  it("names an unnamed live lifecycle claim as unknown", () => {
    expect(
      workbenchClaimHolder({
        lifecycleOperationState: "claiming",
        lifecycleOperationLeaseExpiresAt: leaseAhead,
      }),
    ).toEqual({ name: "unknown", claimedAt: null });
  });
});
