import { describe, expect, it } from "vitest";

import {
  deriveWorkbenchLifecycleActions,
  type WorkbenchLifecycleActionId,
  type WorkbenchLifecyclePolicyInput,
} from "@/lib/workbench-lifecycle/policy";

function input(
  over: Partial<WorkbenchLifecyclePolicyInput> = {},
): WorkbenchLifecyclePolicyInput {
  return {
    runKind: "flow",
    runStatus: "Review",
    scratchDialogStatus: null,
    hasWorkspace: true,
    workspaceRemoved: false,
    workspaceArchived: false,
    claimOwnerUserId: null,
    viewerUserId: null,
    // ADR-181: a caller holding the workspace row passes its DB facts.
    publishedBranch: null,
    prUrl: null,
    prState: null,
    ...over,
  };
}

// ADR-181 D1: a usable parked worktree admits the tree, publish and update git
// set beside archive/drop; openPr/finalizePr wait for a publication and a PR.
const PARKED_GIT_SET: WorkbenchLifecycleActionId[] = [
  "archive",
  "drop",
  "exportBranch",
  "snapshotCommit",
  "discardChanges",
  "update",
];

function enabledActionIds(
  over: Partial<WorkbenchLifecyclePolicyInput> = {},
): WorkbenchLifecycleActionId[] {
  return deriveWorkbenchLifecycleActions(input(over))
    .filter((action) => action.enabled)
    .map((action) => action.id);
}

describe("deriveWorkbenchLifecycleActions", () => {
  it("allows only stop for a live flow workbench", () => {
    expect(enabledActionIds({ runStatus: "Running" })).toEqual(["stop"]);
  });

  it("allows only stop for flow HITL wait states", () => {
    expect(enabledActionIds({ runStatus: "NeedsInput" })).toEqual(["stop"]);
    expect(enabledActionIds({ runStatus: "NeedsInputIdle" })).toEqual(["stop"]);
  });

  it("allows only stop for live scratch dialog states", () => {
    expect(
      enabledActionIds({
        runKind: "scratch",
        runStatus: "Running",
        scratchDialogStatus: "WaitingForUser",
      }),
    ).toEqual(["stop"]);

    expect(
      enabledActionIds({
        runKind: "scratch",
        runStatus: "Running",
        scratchDialogStatus: "Running",
      }),
    ).toEqual(["stop"]);
  });

  it("allows archive, drop, and the git set from stopped review workbenches", () => {
    expect(enabledActionIds({ runStatus: "Review" })).toEqual(PARKED_GIT_SET);
  });

  it.each(["Crashed", "Done", "Abandoned", "Failed"] as const)(
    "allows archive, drop, and the git set from %s workbenches while present",
    (runStatus) => {
      expect(enabledActionIds({ runStatus })).toEqual(PARKED_GIT_SET);
    },
  );

  it("protects human-owned workbenches from lifecycle side effects", () => {
    expect(enabledActionIds({ runStatus: "HumanWorking" })).toEqual([]);
  });

  // ADR-181 D10: a removed worktree is re-attachable, and nothing else is.
  it("offers only reattach after the worktree was removed", () => {
    expect(
      enabledActionIds({
        runStatus: "Done",
        workspaceRemoved: true,
      }),
    ).toEqual(["reattach"]);
  });

  it("uses allow-list guards for unknown future states", () => {
    expect(
      enabledActionIds({
        runStatus:
          "PausedByPolicy" as WorkbenchLifecyclePolicyInput["runStatus"],
      }),
    ).toEqual([]);
  });
});
