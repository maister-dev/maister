import { describe, expect, it } from "vitest";

import { logExecPolicyAction } from "@/lib/runs/exec-policy-audit";

describe("logExecPolicyAction", () => {
  it("returns the structured audit record (the autonomy-action boundary shape)", () => {
    expect(
      logExecPolicyAction({
        runId: "run-1",
        kind: "launched",
        detail: { preset: "unattended" },
      }),
    ).toEqual({
      runId: "run-1",
      kind: "launched",
      detail: { preset: "unattended" },
    });
  });

  it("accepts a detail-less action", () => {
    expect(logExecPolicyAction({ runId: "r", kind: "escalated" })).toEqual({
      runId: "r",
      kind: "escalated",
    });
  });
});
