import { describe, expect, it } from "vitest";

import {
  DISPOSABLE_WORKSPACE_RUN_STATUSES,
  isDisposableWorkspaceRunStatus,
} from "@/lib/runs/run-status-sets";

describe("workspace retention status set", () => {
  it("includes only statuses whose worktrees may be removed automatically", () => {
    expect(DISPOSABLE_WORKSPACE_RUN_STATUSES).toEqual(["Done", "Abandoned"]);
    expect(isDisposableWorkspaceRunStatus("Done")).toBe(true);
    expect(isDisposableWorkspaceRunStatus("Abandoned")).toBe(true);
  });

  it.each(["Review", "Crashed", "Failed", "NeedsInput", "Running"])(
    "keeps %s protected from automatic workspace removal",
    (status) => {
      expect(isDisposableWorkspaceRunStatus(status)).toBe(false);
    },
  );
});
