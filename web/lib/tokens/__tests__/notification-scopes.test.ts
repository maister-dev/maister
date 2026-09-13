/**
 * `UT-NTF-09` (ADR-173 D10) — the two new scopes are WITHHELD from agents.
 *
 * An agent has no business reading a human's decision queue or editing where
 * that human gets notified. Both omissions are asserted rather than assumed,
 * because `AGENT_TOKEN_SCOPES` and `CROSS_PROJECT_AGENT_SCOPES` are hand-curated
 * allow-lists and the natural mistake is to add a scope to `TOKEN_SCOPES` and
 * then to the agent list "for symmetry".
 */

import { describe, expect, it } from "vitest";

import {
  AGENT_TOKEN_SCOPES,
  CROSS_PROJECT_AGENT_SCOPES,
  isTokenScope,
  TOKEN_SCOPES,
} from "@/types/token-scopes";

const WITHHELD = ["decisions:read", "notifications:subscriptions"] as const;

describe("UT-NTF-09 the attention scopes exist", () => {
  it("are both real token scopes", () => {
    for (const scope of WITHHELD) {
      expect(TOKEN_SCOPES as readonly string[], scope).toContain(scope);
      expect(isTokenScope(scope), scope).toBe(true);
    }
  });
});

describe("UT-NTF-09 the attention scopes are withheld from agents", () => {
  it("is absent from AGENT_TOKEN_SCOPES", () => {
    for (const scope of WITHHELD) {
      expect(AGENT_TOKEN_SCOPES as readonly string[], scope).not.toContain(
        scope,
      );
    }
  });

  it("is absent from CROSS_PROJECT_AGENT_SCOPES", () => {
    for (const scope of WITHHELD) {
      expect(
        CROSS_PROJECT_AGENT_SCOPES as readonly string[],
        scope,
      ).not.toContain(scope);
    }
  });

  it("keeps the cross-project list a SUBSET of the agent list", () => {
    // The invariant that makes the two assertions above sufficient: a scope can
    // only be exercised across a project boundary if an agent token may hold it
    // at all, so nothing can sneak in through the second list alone.
    for (const scope of CROSS_PROJECT_AGENT_SCOPES) {
      expect(AGENT_TOKEN_SCOPES as readonly string[], scope).toContain(scope);
    }
  });
});
