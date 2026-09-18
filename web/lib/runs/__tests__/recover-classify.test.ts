// M19 crash-recover (ADR-034): pure classifier `classifyRecover` in
// `web/lib/runs/recover-classify.ts`. Decides how an operator-driven Recover
// treats a Crashed run from the run's acpSessionId, its current node kind, and
// the node's `retry_safe` opt-in.
//
// Contract (Codex round-3 fix; agent set widened by ADR-175):
//   - agent node + acpSessionId present      -> "resume-agent"
//   - agent node + acpSessionId null         -> "discard-only"
//   - session-less + retry_safe=true         -> "redispatch"
//   - session-less + retry_safe=false / null -> "discard-only"
//
// The AGENT set is `ai_coding | judge | orchestrator` — identical to the set
// `admitNodePrompt` admits. ADR-175 moved `judge` INTO it: a judge node always
// ran an ACP session, but the classifier treated it as session-less, so a
// crashed judge with `retry_safe: false` (the default) was `discard-only` and
// its retained handle was thrown away. This file is the contract, so the two
// `judge` rows below moved deliberately — the old expectation was the defect,
// not a regression.
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
  const AGENT_KINDS = ["ai_coding", "judge", "orchestrator"] as const;

  for (const kind of AGENT_KINDS) {
    it(`${kind} + acpSessionId present → resume-agent`, () => {
      expect(
        classifyRecover({ acpSessionId: "acp-1" }, kind, false),
      ).toBe<RecoverPlan>("resume-agent");
      expect(
        classifyRecover({ acpSessionId: "acp-1" }, kind, true),
      ).toBe<RecoverPlan>("resume-agent");
    });

    it(`${kind} + acpSessionId null → discard-only`, () => {
      expect(
        classifyRecover({ acpSessionId: null }, kind, true),
      ).toBe<RecoverPlan>("discard-only");
      expect(
        classifyRecover({ acpSessionId: null }, kind, false),
      ).toBe<RecoverPlan>("discard-only");
    });
  }
});

describe("classifyRecover — session-less node gated on retry_safe", () => {
  // ADR-175: `judge` is no longer here — it is an agent node above.
  const SESSION_LESS: Array<Exclude<NodeKind, "ai_coding" | "judge">> = [
    "cli",
    "check",
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
