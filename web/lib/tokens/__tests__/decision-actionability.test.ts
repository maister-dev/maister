// ---------------------------------------------------------------------------
// UT-ATN-13 — the decision queue's role floor is DERIVED, not hand-listed.
//
// ADR-169 D7: every entry in the queue is something the reader can do NOW.
// All four things it can ask for — answer, promote, recover, clear — require
// project `member`, while `readBoard` is a `viewer` action. Scoping the queue
// by visibility therefore handed viewers items whose inline actions answer 403.
//
// The regression this guards is narrower than "viewers are excluded": a
// hand-written allow-list of acting roles silently drops `owner`, which ranks
// ABOVE `admin` in PROJECT_ORDER and is easy to forget. Derivation is the fix,
// so derivation is what the test pins.
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";

import { PROJECT_ACTION_MIN, projectRolesForActions } from "@/lib/authz";

const DECISION_ACTIONS = [
  "answerHitl",
  "promoteRun",
  "recoverRun",
  "editTask",
] as const;

describe("UT-ATN-13 acting roles for the decision queue", () => {
  it("admits member, admin and owner, and excludes viewer", () => {
    const roles = projectRolesForActions(DECISION_ACTIONS);

    expect([...roles].sort()).toEqual(["admin", "member", "owner"]);
    expect(roles).not.toContain("viewer");
  });

  it("includes owner, the role a hand-written allow-list drops", () => {
    // `owner` ranks above `admin`, so an author writing ["admin","member"] by
    // hand locks project owners out of their own decision queue.
    expect(projectRolesForActions(DECISION_ACTIONS)).toContain("owner");
  });

  it("every decision action really does require at least member", () => {
    // If any of the four is ever relaxed to `viewer`, the queue must widen
    // deliberately rather than through a stale constant here.
    for (const action of DECISION_ACTIONS) {
      expect(PROJECT_ACTION_MIN[action]).not.toBe("viewer");
    }
  });

  it("takes the HIGHEST floor across the actions, not the first", () => {
    // A read action mixed in must not drag the floor down.
    expect(
      [...projectRolesForActions(["readBoard", "promoteRun"])].sort(),
    ).toEqual(["admin", "member", "owner"]);
  });

  it("a viewer-only action set admits every role", () => {
    expect([...projectRolesForActions(["readBoard"])].sort()).toEqual([
      "admin",
      "member",
      "owner",
      "viewer",
    ]);
  });
});
