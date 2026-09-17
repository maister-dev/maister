import type { TokenScope } from "@/types/token-scopes";

import { describe, expect, it } from "vitest";

import {
  toggleScope,
  toggleScopeForEdit,
} from "@/components/board/token-actions";
import { isManagedTokenRow } from "@/lib/tokens/managed-row";

// ADR-168 T5.3. The two toggles differ in exactly one branch, and that branch
// is the whole point: on a CREATE form an empty selection defensibly means
// "default to full"; on an EDIT form the same fallback silently grants `*` to
// the very token the user is restricting. Both halves are asserted together so
// the contrast cannot be lost by "unifying" them later.
describe("token scope toggles — create vs edit", () => {
  it("edit mode: unticking the last scope leaves the selection empty, never the wildcard", () => {
    expect(toggleScopeForEdit(["tasks:read"], "tasks:read")).toEqual([]);
  });

  it("create mode is unchanged: unticking the last scope still falls back to the wildcard", () => {
    expect(toggleScope(["tasks:read"], "tasks:read")).toEqual(["*"]);
  });

  it("edit mode: the wildcard is togglable off, so a user can narrow a full-access token", () => {
    expect(toggleScopeForEdit(["*"], "*")).toEqual([]);
    expect(toggleScopeForEdit([], "*")).toEqual(["*"]);
  });

  it("edit mode: ticking a scope alongside the wildcard replaces it rather than stacking", () => {
    expect(toggleScopeForEdit(["*"], "tasks:read" as TokenScope)).toEqual([
      "tasks:read",
    ]);
  });
});

// ADR-168 D3, client mirror. The affordance is withheld from machine-minted
// run-bound credentials, which DO render in the project token table today
// because listTokens filters on project_id alone.
describe("isManagedTokenRow — which rows may offer Edit", () => {
  it("withholds Edit from agent-kind tokens and from run-bound names of any kind", () => {
    expect(isManagedTokenRow({ kind: "agent", name: "whatever" })).toBe(false);
    expect(
      isManagedTokenRow({ kind: "project", name: "orchestrator-run:run_1" }),
    ).toBe(false);
    expect(isManagedTokenRow({ kind: "user", name: "AGENT-RUN:run_1" })).toBe(
      false,
    );
  });

  it("offers Edit for durable human-issued project and personal tokens", () => {
    expect(isManagedTokenRow({ kind: "project", name: "CI pipeline" })).toBe(
      true,
    );
    expect(isManagedTokenRow({ kind: "user", name: "Personal agent" })).toBe(
      true,
    );
  });
});

// `*` and the exact-only human scope are independent axes on the server —
// normalizeTokenScopes keeps ["*", "hitl:respond:human"] because the wildcard
// does not imply the human grant. The picker must be able to express that pair
// in BOTH directions; folding them into one list could not. Found by
// adversarial review.
describe("token scope toggles — wildcard and exact-only are independent", () => {
  it("edit mode: granting human HITL keeps the wildcard, and vice versa", () => {
    expect(toggleScopeForEdit(["*"], "hitl:respond:human")).toEqual([
      "*",
      "hitl:respond:human",
    ]);
    expect(toggleScopeForEdit(["hitl:respond:human"], "*")).toEqual([
      "*",
      "hitl:respond:human",
    ]);
  });

  it("edit mode: dropping one axis leaves the other standing", () => {
    expect(
      toggleScopeForEdit(["*", "hitl:respond:human"], "hitl:respond:human"),
    ).toEqual(["*"]);
    expect(toggleScopeForEdit(["*", "hitl:respond:human"], "*")).toEqual([
      "hitl:respond:human",
    ]);
  });

  it("edit mode: a named scope coexists with the human grant", () => {
    expect(
      toggleScopeForEdit(["tasks:read", "hitl:respond:human"], "flows:read"),
    ).toEqual(["tasks:read", "flows:read", "hitl:respond:human"]);
  });

  it("create mode gains the same independence, keeping its empty fallback", () => {
    expect(toggleScope(["*"], "hitl:respond:human")).toEqual([
      "*",
      "hitl:respond:human",
    ]);
    // Unticking the last remaining grant still falls back to the wildcard.
    expect(toggleScope(["tasks:read"], "tasks:read")).toEqual(["*"]);
  });
});
