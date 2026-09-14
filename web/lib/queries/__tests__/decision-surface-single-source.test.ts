// ---------------------------------------------------------------------------
// UT-ATN-13 — a decision surface renders the queue it counts, and nothing else.
//
// `ATN-01` says the `decisions` count MUST equal the length of the list it
// labels. Both surfaces printed `queue.count` and then rendered their HITL
// cards from `getCrossProjectHitlInbox` DIRECTLY — a query scoped by
// VISIBILITY rather than actionability, and one that drops no relation-blocked
// task. So a member with viewer access to a second project saw that project's
// HITL cards, with enabled actions that answer 403, above a number that had
// never counted them.
//
// The property is "nowhere else", which no type can express — so, like
// `UT-NTF-13`, the guard is a grep. `hitlDecisionsOf(queue.items)` is the one
// permitted source.
//
// If this fails: render from the canonical queue. A surface that genuinely
// needs the wider population is not a decision surface and does not belong in
// the list below.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEB_ROOT = path.resolve(__dirname, "../../..");

/** Every surface that prints the `decisions` number beside a HITL list. */
const DECISION_SURFACES = ["app/(app)/page.tsx", "app/(app)/inbox/page.tsx"];

function read(rel: string): string {
  return readFileSync(path.join(WEB_ROOT, rel), "utf8");
}

describe("UT-ATN-13 decision surfaces have one HITL source", () => {
  it.each(DECISION_SURFACES)("%s does not query the wider inbox", (rel) => {
    expect(read(rel)).not.toContain("getCrossProjectHitlInbox");
  });

  it.each(DECISION_SURFACES)("%s renders HITL from the queue", (rel) => {
    expect(read(rel)).toContain("hitlDecisionsOf(queue.items)");
  });

  it("can still see the query where it legitimately lives", () => {
    // A grep gate that matches nothing anywhere is indistinguishable from a
    // broken one: the canonical queue is the caller that must still make it.
    expect(read("lib/queries/decisions.ts")).toContain(
      "getCrossProjectHitlInbox",
    );
  });
});
