import { describe, expect, it } from "vitest";

import {
  deriveWorkbenchLifecycleActions,
  type WorkbenchLifecycleAction,
  type WorkbenchLifecyclePolicyInput,
  type WorkbenchRunStatus,
} from "@/lib/workbench-lifecycle/policy";

// T-A8 (AC-A8) — ADR-159 owner carve-out. `HumanWorking` disables EVERY action
// with `human-owned`. The rework claim pokes exactly one hole in that, for
// exactly one actor: the claim owner gets `exportBranch`, which is what makes
// snapshotCommit / handoffBranch / handoff-metadata reachable (all three gate on
// `requireActionAllowed(ctx, "exportBranch")`). Everything else — every other
// action, and every other actor — keeps today's behaviour byte-for-byte.

const OWNER = "user-owner";
const OTHER = "user-other";

function input(
  over: Partial<WorkbenchLifecyclePolicyInput> = {},
): WorkbenchLifecyclePolicyInput {
  return {
    runKind: "flow",
    runStatus: "HumanWorking",
    scratchDialogStatus: null,
    hasWorkspace: true,
    workspaceRemoved: false,
    workspaceArchived: false,
    claimOwnerUserId: null,
    viewerUserId: null,
    ...over,
  };
}

function byId(
  actions: WorkbenchLifecycleAction[],
): Record<string, WorkbenchLifecycleAction> {
  return Object.fromEntries(actions.map((a) => [a.id, a]));
}

describe("T-A8 ADR-159 — HumanWorking lifecycle owner carve-out", () => {
  it("enables exportBranch for the claim owner and nothing else", () => {
    const actions = byId(
      deriveWorkbenchLifecycleActions(
        input({ claimOwnerUserId: OWNER, viewerUserId: OWNER }),
      ),
    );

    expect(actions.exportBranch.enabled).toBe(true);
    expect(actions.exportBranch.disabledReason).toBeNull();

    // The run is mid-handoff: removing its worktree under the operator editing
    // it is never the right default, even for the owner.
    for (const id of ["stop", "archive", "drop"]) {
      expect(actions[id].enabled).toBe(false);
      expect(actions[id].disabledReason).toBe("human-owned");
    }
  });

  it("refuses a non-owner every action, so the carve-out cannot race the owner", () => {
    const actions = deriveWorkbenchLifecycleActions(
      input({ claimOwnerUserId: OWNER, viewerUserId: OTHER }),
    );

    expect(actions.every((a) => !a.enabled)).toBe(true);
    expect(actions.every((a) => a.disabledReason === "human-owned")).toBe(true);
  });

  it("refuses an anonymous viewer even when a claim is open", () => {
    const actions = deriveWorkbenchLifecycleActions(
      input({ claimOwnerUserId: OWNER, viewerUserId: null }),
    );

    expect(actions.every((a) => !a.enabled)).toBe(true);
  });

  // A HumanWorking run with no recorded claim owner is the M11b takeover shape
  // (its claim row carries no `review_rework_claim` decision) — unchanged.
  it("refuses everything when no claim owner is recorded (M11b takeover shape)", () => {
    const actions = deriveWorkbenchLifecycleActions(
      input({ claimOwnerUserId: null, viewerUserId: OWNER }),
    );

    expect(actions.every((a) => !a.enabled)).toBe(true);
    expect(actions.every((a) => a.disabledReason === "human-owned")).toBe(true);
  });

  it.each([
    ["a removed workspace", { workspaceRemoved: true }],
    ["an absent workspace", { hasWorkspace: false }],
  ])(
    "refuses the owner the carve-out with %s",
    (_label, over: Partial<WorkbenchLifecyclePolicyInput>) => {
      const actions = deriveWorkbenchLifecycleActions(
        input({ claimOwnerUserId: OWNER, viewerUserId: OWNER, ...over }),
      );

      expect(actions.every((a) => !a.enabled)).toBe(true);
    },
  );

  // Regression fence: the carve-out is keyed on HumanWorking. Passing a matching
  // owner/viewer pair on any OTHER status must change nothing.
  const OTHER_STATUSES: WorkbenchRunStatus[] = [
    "Running",
    "NeedsInput",
    "NeedsInputIdle",
    "Review",
    "Crashed",
    "Done",
    "Abandoned",
    "Failed",
  ];

  it.each(OTHER_STATUSES)(
    "leaves %s byte-identical whether or not an owner matches",
    (runStatus) => {
      const withoutClaim = deriveWorkbenchLifecycleActions(
        input({ runStatus, claimOwnerUserId: null, viewerUserId: null }),
      );
      const withMatchingClaim = deriveWorkbenchLifecycleActions(
        input({ runStatus, claimOwnerUserId: OWNER, viewerUserId: OWNER }),
      );

      expect(withMatchingClaim).toEqual(withoutClaim);
    },
  );
});
