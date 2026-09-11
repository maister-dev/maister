// `UT-NAV-01` — the Desk COMPOSES (ADR-171 D1).
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
import { NOW_TILE_HREFS, NOW_TILE_IDS } from "@/lib/queries/digest";

const WEB_ROOT = path.resolve(__dirname, "../../..");
const DESK = readFileSync(path.join(WEB_ROOT, "app/(app)/page.tsx"), "utf8");

describe("UT-NAV-01 the Desk composes rather than re-implements", () => {
  it("renders each region through the surface that owns it", () => {
    for (const component of [
      // `/inbox`
      "HitlInboxList",
      "DecisionSections",
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

  it("orders the regions Decisions, Work, Activity in the SOURCE", () => {
    // `EDGE-NAV-02`. The grid is one column below `xl`, so source order IS the
    // narrow order — and the first cut of this page had Work last, which put it
    // below Activity on a phone. Desktop's different arrangement is done with
    // explicit grid placement, never by reordering the source.
    const order = ["desk-decisions", "desk-work", "desk-activity"].map((id) =>
      DESK.indexOf(`testid="${id}"`),
    );

    expect(order.every((at) => at > 0), DESK.slice(0, 0) || "all found").toBe(
      true,
    );
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

  it("names every Now tile in both catalogs", () => {
    for (const catalog of [en.digest, ru.digest] as Array<
      Record<string, string>
    >) {
      for (const id of NOW_TILE_IDS) {
        expect(catalog[id], id).toContain("$count");
      }
      expect(catalog.ariaLabel).toBeTruthy();
    }
  });

  it("points every Now tile at a route that exists", () => {
    for (const id of NOW_TILE_IDS) {
      const href = NOW_TILE_HREFS[id];
      const route = href.split("?")[0];

      expect(
        ["/work", "/inbox", "/activity", "/observatory"],
        `${id} -> ${href}`,
      ).toContain(route);
    }
  });
});
