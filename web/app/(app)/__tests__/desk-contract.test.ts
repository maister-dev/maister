// `UT-NAV-01` — the Desk COMPOSES (ADR-172 D1).
//
// The claim this guards is not "the page renders" — `E2E-NAV-01` owns that. It
// is the architectural one: every region on `/` goes through the component the
// owning surface renders, and the Desk introduces no second copy of a decision
// card, a work row, an activity row, or a mutation path. That is invisible to
// any browser assertion, and a drifted copy looks right until the two surfaces
// disagree.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

const WEB_ROOT = path.resolve(__dirname, "../../..");
const DESK = readFileSync(path.join(WEB_ROOT, "app/(app)/page.tsx"), "utf8");

describe("UT-NAV-01 the Desk composes rather than re-implements", () => {
  it("renders each region through the surface that owns it", () => {
    for (const component of [
      // `/inbox` — `DecisionSections` survives for `Held`; the HITL list does
      // not, because ADR-174 D2 moved that population onto the work row.
      "DecisionSections",
      "HitlPanel",
      // `/work`
      "WorkRowsTable",
      // `/activity`
      "ActivityRowList",
      // the Now strip and the first-run surfaces
      "NowTiles",
      "OnboardingChecklist",
      "EmptyState",
      // the existing scratch launcher, not a new composer
      "ScratchLaunchPopover",
    ]) {
      expect(DESK, component).toMatch(new RegExp(`<${component}[\\s/>]`, "u"));
    }
  });

  it("builds its row labels from the shared builders", () => {
    expect(DESK).toContain("buildWorkRowsLabels");
    expect(DESK).toContain("buildActivityRowLabels");
  });

  it("reads the canonical decision queue, not a private count", () => {
    expect(DESK).toContain('from "@/lib/queries/decisions"');
    expect(DESK).toContain("getDecisionsQueue");
    expect(DESK).not.toContain("computeDecisionsQueue");
  });

  it("T-D4 renders no digest window, while the module survives for ADR-173", () => {
    // ADR-174 D3: the Desk is current state, not a window. `formatDigest` and
    // `getNowTileCounts` stay in the codebase — the notification trigger is
    // their real caller — but nothing here computes or prints a window.
    expect(DESK).not.toContain("formatDigest");
    expect(DESK).not.toContain("getNowTileCounts");
    expect(DESK).not.toContain("desk-digest");
  });

  it("T-D15 joins rows to decisions from the queue it already loads", () => {
    // `REQ-D15`: the row -> decision join is built HERE, on `runId`, from the
    // canonical queue. A read-model change would have been the tell that the
    // merge was really a rewrite.
    expect(DESK).toContain("decisionByRunId");
    expect(DESK).toContain("queue.items");
    expect(DESK).toContain("getWorkTable({ id: user.id, role: user.role })");

    // And `getWorkTable` gained nothing Desk-shaped on the other side.
    const readModel = readFileSync(
      path.join(WEB_ROOT, "lib/queries/work-table.ts"),
      "utf8",
    );

    expect(readModel.toLowerCase()).not.toContain("desk");
    expect(readModel).not.toContain("decision");
  });

  it("adds no mutation path of its own", () => {
    // The Desk is a read surface. A `fetch`/server action here would be a
    // second way to promote, recover or answer — the thing D1 forbids.
    expect(DESK).not.toContain("use server");
    expect(DESK).not.toMatch(/fetch\(/u);
    expect(DESK).not.toMatch(/method:\s*"POST"/u);
  });

  it("keeps the composer out of the empty state", () => {
    // `EDGE-NAV-01`: the scratch composer is absent until a project exists.
    expect(DESK).toMatch(/hasProjects \?\s*\(?\s*<ScratchLaunchPopover/u);
  });

  it("orders the regions Held, Work, Activity in the SOURCE", () => {
    // `EDGE-NAV-02`. The grid is one column below `xl`, so source order IS the
    // narrow order — and the first cut of this page had Work last, which put it
    // below Activity on a phone. Desktop's different arrangement is done with
    // explicit grid placement, never by reordering the source.
    const order = ["desk-held", "desk-work", "desk-activity"].map((id) =>
      DESK.indexOf(`testid="${id}"`),
    );

    expect(
      order.every((at) => at > 0),
      DESK.slice(0, 0) || "all found",
    ).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("places the desktop arrangement with grid coordinates, not with order", () => {
    expect(DESK).toContain("xl:grid-cols-");
    // Work spans the full width on row 2; Decisions and Activity share row 1.
    expect(DESK).toContain("xl:col-span-2 xl:col-start-1 xl:row-start-2");
    expect(DESK).toContain("xl:col-start-1 xl:row-start-1");
    expect(DESK).toContain("xl:col-start-2 xl:row-start-1");
  });
});

describe("UT-NAV-01 Desk i18n", () => {
  const deskKeys = Object.keys(en.desk);

  it("has the desk namespace in both catalogs with identical keys", () => {
    expect(deskKeys.length).toBeGreaterThan(0);
    expect(Object.keys(ru.desk).sort()).toEqual([...deskKeys].sort());
  });

  it("renders every count-bearing template through $count", () => {
    for (const catalog of [en.desk, ru.desk] as Array<Record<string, string>>) {
      for (const [key, value] of Object.entries(catalog)) {
        // `{count}` would reach intl-messageformat and throw; the client-side
        // convention in this milestone is replacement, not ICU.
        expect(value, key).not.toMatch(/\{count\}/u);
        if (/Count$/u.test(key)) expect(value, key).toContain("$count");
      }
    }
  });

  // `T-D23` (`AC-D23`), the coverage half of the i18n contract.
  //
  // Parity alone cannot catch an orphan: it only proves EN and RU agree, and two
  // catalogs agree perfectly about a key neither surface renders. That is how
  // `desk.sub` and `desk.nowLabel` both sat unused — present, translated, and
  // reaching no reader. A key with no render site is either dead weight or a
  // string someone believes is on screen and is not.
  it("T-D23 gives every desk key a render site on the page", () => {
    for (const key of deskKeys) {
      expect(DESK, `desk.${key}`).toMatch(
        new RegExp(`\\bt\\(\\s*"${key}"\\s*\\)`, "u"),
      );
    }
  });
});
