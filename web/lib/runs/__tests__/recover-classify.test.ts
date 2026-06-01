// M19 Phase 3 (T3.1): pure classifier `classifyRecover` in
// `web/lib/runs/recover.ts`. The recovery-plan analogue of
// `classifyRunReconcile` — decides how an operator-driven Recover treats a
// Crashed run based on the run's acpSessionId and its current node kind.
//
// Contract (plan T3.1):
//   - ai_coding + acpSessionId present  -> "resume-agent"
//   - ai_coding + acpSessionId null     -> "discard-only"
//   - any other node kind (cli/check/judge/guard/human/null) -> "redispatch"
//
// PURE: no clock/db access; the run shape is a plain object literal.

import { describe, expect, it } from "vitest";

import type { RecoverPlan } from "@/lib/runs/recover";

import { classifyRecover } from "@/lib/runs/recover";

type NodeKind = "ai_coding" | "cli" | "check" | "judge" | "guard" | "human" | null;

describe("classifyRecover — agent node", () => {
  it("ai_coding + acpSessionId present → resume-agent", () => {
    expect(
      classifyRecover({ acpSessionId: "acp-1" }, "ai_coding"),
    ).toBe<RecoverPlan>("resume-agent");
  });

  it("ai_coding + acpSessionId null → discard-only", () => {
    expect(
      classifyRecover({ acpSessionId: null }, "ai_coding"),
    ).toBe<RecoverPlan>("discard-only");
  });
});

describe("classifyRecover — non-agent node → redispatch", () => {
  const REDISPATCH_KINDS: Array<Exclude<NodeKind, "ai_coding">> = [
    "cli",
    "check",
    "judge",
    "guard",
    "human",
    null,
  ];

  for (const kind of REDISPATCH_KINDS) {
    it(`${String(kind)} node → redispatch (regardless of acpSessionId presence)`, () => {
      // A session-less gate node is re-dispatched via runFlow; the acpSessionId
      // (if any) is irrelevant to a non-agent node's recovery plan.
      expect(classifyRecover({ acpSessionId: "acp-1" }, kind)).toBe<RecoverPlan>(
        "redispatch",
      );
      expect(classifyRecover({ acpSessionId: null }, kind)).toBe<RecoverPlan>(
        "redispatch",
      );
    });
  }
});
