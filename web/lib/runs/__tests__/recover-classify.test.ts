// M19 crash-recover (ADR-034): pure classifier `classifyRecover` in
// `web/lib/runs/recover-classify.ts`. Decides how an operator-driven Recover
// treats a Crashed run from the run's acpSessionId, its current node kind, and
// the node's `retry_safe` opt-in.
//
// Contract (Codex round-3 fix):
//   - ai_coding + acpSessionId present       -> "resume-agent"
//   - ai_coding + acpSessionId null          -> "discard-only"
//   - session-less + retry_safe=true         -> "redispatch"
//   - session-less + retry_safe=false / null -> "discard-only"
//
// PURE: no clock/db access; the run shape is a plain object literal.

import type { RecoverPlan } from "@/lib/runs/recover-classify";

import { describe, expect, it } from "vitest";

import { classifyRecover } from "@/lib/runs/recover-classify";

type NodeKind =
  | "ai_coding"
  | "cli"
  | "check"
  | "judge"
  | "guard"
  | "human"
  | "consensus"
  | null;

describe("classifyRecover — agent node (ignores retry_safe)", () => {
  it("ai_coding + acpSessionId present → resume-agent", () => {
    expect(
      classifyRecover({ acpSessionId: "acp-1" }, "ai_coding", false),
    ).toBe<RecoverPlan>("resume-agent");
    expect(
      classifyRecover({ acpSessionId: "acp-1" }, "ai_coding", true),
    ).toBe<RecoverPlan>("resume-agent");
  });

  it("ai_coding + acpSessionId null → discard-only", () => {
    expect(
      classifyRecover({ acpSessionId: null }, "ai_coding", true),
    ).toBe<RecoverPlan>("discard-only");
  });
});

describe("classifyRecover — session-less node gated on retry_safe", () => {
  const SESSION_LESS: Array<Exclude<NodeKind, "ai_coding">> = [
    "cli",
    "check",
    "judge",
    "guard",
    "human",
    "consensus",
    null,
  ];

  for (const kind of SESSION_LESS) {
    it(`${String(kind)} + retry_safe=true → redispatch (acpSessionId irrelevant)`, () => {
      expect(
        classifyRecover({ acpSessionId: "acp-1" }, kind, true),
      ).toBe<RecoverPlan>("redispatch");
      expect(
        classifyRecover({ acpSessionId: null }, kind, true),
      ).toBe<RecoverPlan>("redispatch");
    });

    it(`${String(kind)} + retry_safe=false → discard-only (re-run unsafe)`, () => {
      expect(
        classifyRecover({ acpSessionId: "acp-1" }, kind, false),
      ).toBe<RecoverPlan>("discard-only");
      expect(
        classifyRecover({ acpSessionId: null }, kind, false),
      ).toBe<RecoverPlan>("discard-only");
    });
  }
});
