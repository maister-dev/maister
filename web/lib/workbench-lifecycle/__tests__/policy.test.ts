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
    ...over,
  };
}

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
    expect(enabledActionIds({ runStatus: "NeedsInputIdle" })).toEqual([
      "stop",
    ]);
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

  it("allows archive, drop, and export from stopped review workbenches", () => {
    expect(enabledActionIds({ runStatus: "Review" })).toEqual([
      "archive",
      "drop",
      "exportBranch",
    ]);
  });

  it.each(["Crashed", "Done", "Abandoned", "Failed"] as const)(
    "allows archive, drop, and export from %s workbenches while present",
    (runStatus) => {
      expect(enabledActionIds({ runStatus })).toEqual([
        "archive",
        "drop",
        "exportBranch",
      ]);
    },
  );

  it("protects human-owned workbenches from lifecycle side effects", () => {
    expect(enabledActionIds({ runStatus: "HumanWorking" })).toEqual([]);
  });

  it("does not offer archive, drop, or export after the worktree was removed", () => {
    expect(
      enabledActionIds({
        runStatus: "Done",
        workspaceRemoved: true,
      }),
    ).toEqual([]);
  });

  it("uses allow-list guards for unknown future states", () => {
    expect(
      enabledActionIds({
        runStatus: "PausedByPolicy" as WorkbenchLifecyclePolicyInput["runStatus"],
      }),
    ).toEqual([]);
  });
});
