// M19 Phase 1 (T1.H): the run-detail DTO exposes a `recoverable` boolean —
// true iff the run is `Crashed`, still holds an `acpSessionId` checkpoint
// handle, AND its current node is an agent node (`ai_coding`). The raw
// `acpSessionId` is NEVER surfaced; only this derived boolean reaches the
// client. `isRunRecoverable` is the pure predicate behind that field.

import type { NodeAttemptType } from "@/lib/db/schema";

import { describe, expect, it } from "vitest";

import { isRunRecoverable } from "@/lib/queries/run";

describe("isRunRecoverable — run-detail recoverability (M19)", () => {
  it("Crashed + acpSessionId + agent node → recoverable", () => {
    expect(
      isRunRecoverable({
        status: "Crashed",
        acpSessionId: "acp-session-123",
        currentNodeKind: "ai_coding",
      }),
    ).toBe(true);
  });

  it("Crashed + agent node but NO acpSessionId → not recoverable", () => {
    expect(
      isRunRecoverable({
        status: "Crashed",
        acpSessionId: null,
        currentNodeKind: "ai_coding",
      }),
    ).toBe(false);
  });

  it("Crashed + acpSessionId but current node is a gate (not agent) → not recoverable", () => {
    expect(
      isRunRecoverable({
        status: "Crashed",
        acpSessionId: "acp-session-123",
        currentNodeKind: "check",
      }),
    ).toBe(false);
  });

  it("not Crashed (Running) even with agent node + acpSessionId → not recoverable", () => {
    expect(
      isRunRecoverable({
        status: "Running",
        acpSessionId: "acp-session-123",
        currentNodeKind: "ai_coding",
      }),
    ).toBe(false);
  });

  it("Crashed + acpSessionId but no current node resolved → not recoverable", () => {
    expect(
      isRunRecoverable({
        status: "Crashed",
        acpSessionId: "acp-session-123",
        currentNodeKind: null,
      }),
    ).toBe(false);
  });

  it("non-agent node kinds are never recoverable", () => {
    const nonAgent: NodeAttemptType[] = [
      "cli",
      "check",
      "judge",
      "human",
      "guard",
    ];

    for (const kind of nonAgent) {
      expect(
        isRunRecoverable({
          status: "Crashed",
          acpSessionId: "acp-session-123",
          currentNodeKind: kind,
        }),
      ).toBe(false);
    }
  });
});
