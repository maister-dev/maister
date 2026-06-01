// M19 Phase 1 (T1.E): a Crashed *flow* run (runKind='flow') gains the
// recover/discard action that previously only scratch runs got. The action
// is `recover` when the run still has an acp_session_id checkpoint handle,
// otherwise `discard`. Non-crashed flow runs expose no recover/discard
// action. Existing scratch-run behavior is unchanged.

import { describe, expect, it } from "vitest";

import { scratchActionForWorkspace } from "@/lib/queries/portfolio";

describe("portfolio recover/discard action — Crashed flow runs (M19)", () => {
  it("Crashed flow + acpSessionId → 'recover'", () => {
    expect(
      scratchActionForWorkspace({
        runKind: "flow",
        runStatus: "Crashed",
        dialogStatus: null,
        acpSessionId: "acp-session-123",
      }),
    ).toBe("recover");
  });

  it("Crashed flow + null acpSessionId → 'discard'", () => {
    expect(
      scratchActionForWorkspace({
        runKind: "flow",
        runStatus: "Crashed",
        dialogStatus: null,
        acpSessionId: null,
      }),
    ).toBe("discard");
  });

  it("non-crashed flow run → 'none' (no recover/discard surfaced)", () => {
    expect(
      scratchActionForWorkspace({
        runKind: "flow",
        runStatus: "Running",
        dialogStatus: null,
        acpSessionId: "acp-session-123",
      }),
    ).toBe("none");
  });
});

describe("portfolio recover/discard action — scratch runs unchanged (regression)", () => {
  it("Crashed scratch + acpSessionId → 'recover'", () => {
    expect(
      scratchActionForWorkspace({
        runKind: "scratch",
        runStatus: "Crashed",
        dialogStatus: "Crashed",
        acpSessionId: "acp-session-123",
      }),
    ).toBe("recover");
  });

  it("Crashed scratch + null acpSessionId → 'discard'", () => {
    expect(
      scratchActionForWorkspace({
        runKind: "scratch",
        runStatus: "Crashed",
        dialogStatus: "Crashed",
        acpSessionId: null,
      }),
    ).toBe("discard");
  });

  it("scratch in Review dialog → 'open'", () => {
    expect(
      scratchActionForWorkspace({
        runKind: "scratch",
        runStatus: "Review",
        dialogStatus: "Review",
        acpSessionId: null,
      }),
    ).toBe("open");
  });
});
