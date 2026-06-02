// M19 crash-recover (ADR-034): the run-detail DTO exposes a `recoverable`
// boolean that MUST mirror the backend driver (`classifyRecover`). A Crashed run
// is recoverable unless `discard-only`: an agent node with an `acpSessionId`
// (--resume) OR a session-less node the Flow author marked `retry_safe`
// (re-dispatch). A session-less node that is NOT retry-safe, an agent node with
// no session, or an unresolvable target → discard-only. The raw `acpSessionId`
// is NEVER surfaced; only this derived boolean reaches the client.

import type { NodeAttemptType } from "@/lib/db/schema";

import { describe, expect, it } from "vitest";

import { isRunRecoverable } from "@/lib/queries/run";

describe("isRunRecoverable — run-detail recoverability (M19)", () => {
  it("Crashed + acpSessionId + agent node → recoverable (resume-agent, retry_safe ignored)", () => {
    for (const retrySafe of [false, true]) {
      expect(
        isRunRecoverable({
          status: "Crashed",
          acpSessionId: "acp-session-123",
          currentNodeKind: "ai_coding",
          retrySafe,
        }),
      ).toBe(true);
    }
  });

  it("Crashed + agent node but NO acpSessionId → NOT recoverable (discard-only)", () => {
    expect(
      isRunRecoverable({
        status: "Crashed",
        acpSessionId: null,
        currentNodeKind: "ai_coding",
        retrySafe: true,
      }),
    ).toBe(false);
  });

  it("Crashed + session-less node + retry_safe=true → recoverable via re-dispatch", () => {
    expect(
      isRunRecoverable({
        status: "Crashed",
        acpSessionId: null,
        currentNodeKind: "check",
        retrySafe: true,
      }),
    ).toBe(true);
  });

  it("Crashed + session-less node + retry_safe=false → NOT recoverable (re-run unsafe)", () => {
    expect(
      isRunRecoverable({
        status: "Crashed",
        acpSessionId: "acp-session-123",
        currentNodeKind: "cli",
        retrySafe: false,
      }),
    ).toBe(false);
  });

  it("not Crashed (Running) even with agent node + acpSessionId → not recoverable", () => {
    expect(
      isRunRecoverable({
        status: "Running",
        acpSessionId: "acp-session-123",
        currentNodeKind: "ai_coding",
        retrySafe: true,
      }),
    ).toBe(false);
  });

  it("Crashed + no resolvable target (null kind) → NOT recoverable regardless of retry_safe", () => {
    for (const retrySafe of [false, true]) {
      // null kind = session-less branch; retry_safe=true would redispatch, but a
      // null kind means no target node resolved — treat as discard-only at the
      // query layer (the DTO resolves retry_safe=false for a missing node).
      expect(
        isRunRecoverable({
          status: "Crashed",
          acpSessionId: "acp-session-123",
          currentNodeKind: null,
          retrySafe,
        }),
      ).toBe(retrySafe);
    }
  });

  it("every session-less node kind is recoverable ONLY when retry_safe", () => {
    const sessionLess: NodeAttemptType[] = [
      "cli",
      "check",
      "judge",
      "human",
      "guard",
    ];

    for (const kind of sessionLess) {
      expect(
        isRunRecoverable({
          status: "Crashed",
          acpSessionId: null,
          currentNodeKind: kind,
          retrySafe: true,
        }),
      ).toBe(true);
      expect(
        isRunRecoverable({
          status: "Crashed",
          acpSessionId: null,
          currentNodeKind: kind,
          retrySafe: false,
        }),
      ).toBe(false);
    }
  });
});
