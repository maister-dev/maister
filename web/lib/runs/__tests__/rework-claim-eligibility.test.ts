import { describe, expect, it } from "vitest";

import { isMaisterError } from "@/lib/errors";
import {
  assertReworkClaimEligible,
  type ReworkClaimEligibilityRun,
} from "@/lib/runs/rework-claim";

// T-A1 (AC-A1) / T-A2 (AC-A2) — ADR-160 eligibility.
// The gate is an ALLOW-LIST: every term must hold, and a status not named is
// rejected by default rather than falling through. The predicate copies ADR-141
// sync's terms but NARROWS run_kind to `flow` — sync is a branch operation (it
// needs only a worktree and a branch), a rework claim is a graph re-entry
// operation, and an agent run carries no node_attempts rows to anchor on.

function run(
  over: Partial<ReworkClaimEligibilityRun> = {},
): ReworkClaimEligibilityRun {
  return {
    status: "Review",
    runKind: "flow",
    parentRunId: null,
    workspaceMode: null,
    isLaunchedLineage: false,
    ...over,
  };
}

function refusal(
  r: ReworkClaimEligibilityRun,
  workspace: { removedAt: Date | null } | null = { removedAt: null },
): { code: string; message: string } | null {
  try {
    assertReworkClaimEligible(r, workspace);

    return null;
  } catch (err) {
    return {
      code: isMaisterError(err) ? err.code : "UNKNOWN",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

describe("T-A1 ADR-160 — rework-claim eligibility allow-list", () => {
  it("admits a top-level, non-shared, non-lineage Review flow run with a live workspace", () => {
    expect(refusal(run())).toBeNull();
  });

  it.each([
    ["Running"],
    ["NeedsInput"],
    ["NeedsInputIdle"],
    ["HumanWorking"],
    ["Done"],
    ["Crashed"],
    ["Failed"],
    ["Abandoned"],
    ["Pending"],
  ])("refuses status %s with PRECONDITION", (status) => {
    const r = refusal(run({ status }));

    expect(r?.code).toBe("PRECONDITION");
    expect(r?.message).toContain("Review");
  });

  // Allow-list default: an unrecognized status must be refused, not admitted.
  it("rejects an unknown future status by default", () => {
    const r = refusal(run({ status: "PausedByPolicy" }));

    expect(r?.code).toBe("PRECONDITION");
  });

  it("refuses an orchestrator child, protecting SETTLED_RUN_STATUSES", () => {
    const r = refusal(run({ parentRunId: "parent-1" }));

    expect(r?.code).toBe("PRECONDITION");
    expect(r?.message.toLowerCase()).toContain("orchestrator");
  });

  it("refuses a shared-tree run", () => {
    const r = refusal(run({ workspaceMode: "shared" }));

    expect(r?.code).toBe("PRECONDITION");
    expect(r?.message.toLowerCase()).toContain("shared");
  });

  it("refuses a launched evaluation participant", () => {
    const r = refusal(run({ isLaunchedLineage: true }));

    expect(r?.code).toBe("PRECONDITION");
    expect(r?.message.toLowerCase()).toContain("evaluation");
  });

  it("refuses an absent workspace", () => {
    const r = refusal(run(), null);

    expect(r?.code).toBe("PRECONDITION");
    expect(r?.message.toLowerCase()).toContain("workspace");
  });

  it("refuses a removed workspace", () => {
    const r = refusal(run(), { removedAt: new Date() });

    expect(r?.code).toBe("PRECONDITION");
    expect(r?.message.toLowerCase()).toContain("removed");
  });
});

describe("T-A2 ADR-160 — agent runs are structurally excluded", () => {
  // Explicit and EARLY, with a message that says why — rather than letting the
  // caller fall through to a confusing "no re-entry declared" later.
  it.each([["agent"], ["scratch"]])(
    "refuses run_kind %s and names the alternatives",
    (runKind) => {
      const r = refusal(run({ runKind }));

      expect(r?.code).toBe("PRECONDITION");
      expect(r?.message.toLowerCase()).toContain("flow");
      // The operator is pointed at the two operations that DO apply.
      expect(r?.message.toLowerCase()).toMatch(/sync|relaunch|new run/);
    },
  );

  // ADR-141 sync admits `agent`; this predicate deliberately does not. Pin the
  // divergence so a future "share the predicate" refactor has to confront it.
  it("diverges from ADR-141 sync, which admits agent runs", () => {
    const r = refusal(run({ runKind: "agent" }));

    expect(r).not.toBeNull();
  });
});
