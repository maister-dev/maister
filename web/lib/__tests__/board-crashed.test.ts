// M19 Phase 1 (T1.D): board fan-out gains a dedicated "Crashed" column.
// deriveStage must surface a Crashed run as its own column (checked BEFORE
// the terminal-failed Backlog rule), while Failed/Abandoned keep mapping to
// Backlog (the retry rule). "Crashed" is added to BOARD_COLUMNS.

import type { DeriveStageInput, RunStatus } from "@/lib/board";

import { describe, expect, it } from "vitest";

import { BOARD_COLUMNS, deriveStage } from "@/lib/board";

function s(
  runStatus: RunStatus | null,
  opts: Partial<Omit<DeriveStageInput, "runStatus">> = {},
): DeriveStageInput {
  return {
    taskStatus: opts.taskStatus ?? "InFlight",
    taskStage: opts.taskStage ?? "Backlog",
    runStatus,
    workspaceRemoved: opts.workspaceRemoved ?? false,
  };
}

describe("board — Crashed column (M19)", () => {
  it("Crashed run → 'Crashed' (own column, not Backlog)", () => {
    expect(deriveStage(s("Crashed"))).toBe("Crashed");
  });

  it("Crashed wins over Prepare taskStage", () => {
    expect(deriveStage(s("Crashed", { taskStage: "Prepare" }))).toBe("Crashed");
  });

  it("Failed still maps to Backlog (retry rule)", () => {
    expect(deriveStage(s("Failed"))).toBe("Backlog");
  });

  it("Abandoned still maps to Backlog (retry rule)", () => {
    expect(deriveStage(s("Abandoned"))).toBe("Backlog");
  });

  it("'Crashed' is a member of BOARD_COLUMNS", () => {
    expect(BOARD_COLUMNS).toContain("Crashed");
  });
});
