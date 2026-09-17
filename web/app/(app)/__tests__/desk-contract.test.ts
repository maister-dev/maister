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
      // `/inbox` — `DecisionSections` survives for `Held`, and `HitlPanel` is
      // the body `/inbox` itself is now rebuilt on.
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
    ]) {
      expect(DESK, component).toMatch(new RegExp(`<${component}[\\s/>]`, "u"));
    }
  });

  it("renders neither the HITL list nor the scratch composer", () => {
    // ADR-174 D2 moved the HITL population onto the work row; `REQ-D22` removed
    // the composer outright, because the rail already renders the launcher with
    // the global Cmd/Ctrl+K listener and a second one opened two dialogs.
    for (const gone of ["HitlInboxList", "ScratchLaunchPopover"]) {
      expect(DESK, gone).not.toMatch(new RegExp(`<${gone}[\\s/>]`, "u"));
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

  it("EDGE-NAV-01 gates only the first-run frame on having projects", () => {
    // The composer used to be the other thing this flag gated. It is gone
    // unconditionally now, so `hasProjects` must reach exactly one consumer:
    // the onboarding + empty-state frame.
    expect(DESK).toContain("desk-empty");
    expect(DESK).not.toContain("ScratchLaunchPopover");
  });

  it("AC-D21 orders the regions Work, Held, Activity in the SOURCE", () => {
    const order = ["desk-work", "desk-held", "desk-activity"].map((id) =>
      DESK.indexOf(`testid="${id}"`),
    );

    expect(
      order.every((at) => at > 0),
      "all three regions present",
    ).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("AC-D21 lays out one column at EVERY width", () => {
    // There is no second arrangement any more, so the rendered order IS the
    // source order asserted above and the two cannot disagree. A returning
    // `xl:` placement would reintroduce a layout this test cannot see.
    expect(DESK).not.toMatch(/xl:grid-cols-/u);
    expect(DESK).not.toMatch(/xl:col-(start|span)-/u);
    expect(DESK).not.toMatch(/xl:row-start-/u);
  });

  it("AC-D2 reads no query beyond the ones it already made", () => {
    // `REQ-D2`: the strip is a SUMMARY of rows the page already loads. The
    // cheapest way to break that is a new read model for the five numbers, so
    // the allow-list is the assertion.
    const queryImports = [
      ...DESK.matchAll(/from "(@\/lib\/queries\/[a-z-]+)"/gu),
    ].map((match) => match[1]);

    expect([...new Set(queryImports)].sort()).toEqual([
      "@/lib/queries/activity-cursor",
      "@/lib/queries/activity-feed",
      "@/lib/queries/decisions",
      "@/lib/queries/portfolio",
      "@/lib/queries/work-table",
    ]);
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
