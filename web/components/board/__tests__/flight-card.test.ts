import type { FlightCard as FlightCardData } from "@/lib/queries/board";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  FlightCard,
  type FlightCardLabels,
} from "@/components/board/flight-card";

const labels: FlightCardLabels = {
  reworking: "Reworking",
  claimedBy: "claimed by",
  takeoverReturn: "Return",
  elapsed: "elapsed",
  settingsRefused: "Settings refused at launch",
  // T15 (M15): unified readiness badge labels, replacing the old
  // evidenceStale / mergeBlocked / externalGatePending labels.
  readiness: {
    ready: "Ready",
    blocked: "Blocked",
    stale: "Stale",
    failed: "Failed",
    waiting: "Waiting",
    overridden: "Overridden",
  },
};

function baseCard(over: Partial<FlightCardData> = {}): FlightCardData {
  return {
    taskId: "task-1",
    runId: "run-1",
    branch: "maister/fix-thing",
    agent: "claude",
    status: "running",
    stepLabel: "implement",
    stepBody: "implement step",
    spine: Array.from({ length: 7 }, () => ({ state: "todo" as const })),
    time: "3m",
    plus: null,
    minus: null,
    reworking: false,
    owner: null,
    refused: false,
    crashAction: null,
    readiness: "ready",
    ...over,
  };
}

function render(card: FlightCardData): string {
  return renderToStaticMarkup(createElement(FlightCard, { card, labels }));
}

describe("FlightCard — humanworking takeover surface (M11b)", () => {
  it("renders owner, elapsed, branch, and a Return action for a humanworking card", () => {
    const html = render(
      baseCard({
        status: "humanworking",
        agent: "dev",
        owner: "Reviewer Rae",
        time: "12m",
        branch: "maister/takeover-branch",
      }),
    );

    // Owner is shown via the "claimed by <owner>" badge.
    expect(html).toContain("claimed by");
    expect(html).toContain("Reviewer Rae");
    // Branch is rendered.
    expect(html).toContain("maister/takeover-branch");
    // Elapsed time since the claim is rendered.
    expect(html).toContain("12m");
    // A pending-Return affordance is present.
    expect(html).toContain("Return");
    // The takeover agent pill reuses the existing `dev` pill.
    expect(html).toContain(">dev<");
  });

  it("is visually distinct from a normal running card", () => {
    const running = render(baseCard({ status: "running" }));
    const humanworking = render(
      baseCard({ status: "humanworking", agent: "dev", owner: "Rae" }),
    );

    // The running card carries neither the claimed-by badge nor a Return action.
    expect(running).not.toContain("claimed by");
    expect(running).not.toContain("Return");
    // The two cards do not render identical markup — the humanworking surface
    // changes the card body.
    expect(humanworking).not.toBe(running);
  });

  it("still renders the M11a reworking indicator (no regression)", () => {
    const html = render(baseCard({ status: "running", reworking: true }));

    // The reworking indicator (↺) is still present, label threaded.
    expect(html).toContain("Reworking");
    expect(html).toContain("↺");
  });

  it("does not regress the needs-input card", () => {
    const html = render(baseCard({ status: "needs" }));

    // Needs cards do not show the takeover surface.
    expect(html).not.toContain("claimed by");
    expect(html).not.toContain("Return");
    // The needs step body still renders.
    expect(html).toContain("implement step");
  });
});

// MIGRATED from the M12 evidence-badge suite: the merge-blocked (◆) and
// evidence-stale (≈) chips collapse into the single readiness badge. A stale
// required artifact / merge-blocking gate now surfaces as readiness "stale".
describe("FlightCard — evidence readiness (M12 → T15)", () => {
  it("renders the unified readiness badge for a stale run (was evidence-stale/merge-blocked)", () => {
    const html = render(baseCard({ readiness: "stale" }));

    // The single readiness chip carries the translated state label.
    expect(html).toContain('aria-label="Stale"');
    expect(html).toContain('title="Stale"');
    expect(html).toContain('data-readiness="stale"');
    // The old per-signal glyphs are gone.
    expect(html).not.toContain("◆");
    expect(html).not.toContain("≈");
  });

  it("omits the readiness badge when the run is ready (was both evidence flags false)", () => {
    const html = render(baseCard({ readiness: "ready" }));

    expect(html).not.toContain("data-readiness=");
    expect(html).not.toContain("◆");
    expect(html).not.toContain("≈");
  });
});

// MIGRATED from the M16 external-gate-pending suite: a pending blocking
// external_check gate now surfaces as readiness "waiting" via the unified badge.
describe("FlightCard — external gate readiness (M16 → T15)", () => {
  it("renders the unified readiness badge for a waiting run (was external-gate-pending)", () => {
    const html = render(baseCard({ readiness: "waiting" }));

    expect(html).toContain('aria-label="Waiting"');
    expect(html).toContain('title="Waiting"');
    expect(html).toContain('data-readiness="waiting"');
    // The old external-gate glyph is gone.
    expect(html).not.toContain("◉");
  });

  it("omits the readiness badge when the run is ready (was external gate not pending)", () => {
    const html = render(baseCard({ readiness: "ready" }));

    expect(html).not.toContain("data-readiness=");
    expect(html).not.toContain("◉");
  });
});

// T15 (RED): unified readiness badge replacing the three booleans.
//
// CONTRACT CHANGE:
//   The FlightCard component currently renders three independent badge spans:
//   - mergeBlocked (◆)
//   - evidenceStale (≈)
//   - externalGatePending (◉)
//
//   Task 15 unifies these into a SINGLE readiness badge. The three booleans
//   are replaced by a single `readiness: ReadinessState` prop. The badge:
//   - Renders ONLY when readiness !== "ready" AND card status !== "done".
//   - Shows one state-specific label from i18n `readiness.<state>`.
//   - Carries `data-readiness="<state>"` for styling/testing.
//   - The OTHER indicators (reworking, refused) are UNCHANGED.
//
// MIGRATION PATH:
//   OLD: line 122-148 render three spans (mergeBlocked, evidenceStale, externalGatePending).
//   NEW: line 122-130 (estimate) render ONE span when readiness != ready.
//
// readiness field does not exist yet → RED (field missing; old 3-badge code
// still present in component).
describe("FlightCard — unified readiness badge (M15, T15)", () => {
  // Before: 3 separate spans; After: 1 readiness span.
  // This test documents what WILL REPLACE the old 3-badge code.

  it("renders a single readiness badge when readiness='failed' and card not done", () => {
    const html = render(baseCard({ readiness: "failed" }));

    // The badge should carry data-readiness for the implementor to style.
    expect(html).toContain('data-readiness="failed"');
    // One badge only (no ◆/≈/◉ glyphs — those are old).
    // The label comes from i18n readiness.failed.
    expect(html).toContain("aria-label=");
  });

  it("renders a single readiness badge when readiness='stale'", () => {
    const html = render(baseCard({ readiness: "stale" }));

    expect(html).toContain('data-readiness="stale"');
  });

  it("renders a single readiness badge when readiness='blocked'", () => {
    const html = render(baseCard({ readiness: "blocked" }));

    expect(html).toContain('data-readiness="blocked"');
  });

  it("renders a single readiness badge when readiness='waiting'", () => {
    const html = render(baseCard({ readiness: "waiting" }));

    expect(html).toContain('data-readiness="waiting"');
  });

  it("renders a single readiness badge when readiness='overridden'", () => {
    const html = render(baseCard({ readiness: "overridden" }));

    expect(html).toContain('data-readiness="overridden"');
  });

  it("does NOT render a badge when readiness='ready'", () => {
    const html = render(baseCard({ readiness: "ready" }));

    // No data-readiness attribute when ready.
    expect(html).not.toContain("data-readiness=");
  });

  it("does NOT render a badge on a done card, even if readiness='failed'", () => {
    const html = render(baseCard({ status: "done", readiness: "failed" }));

    // Done cards always show no readiness badge (done is terminal).
    expect(html).not.toContain("data-readiness=");
  });

  // The reworking indicator MUST still render (M11a).
  it("still renders the reworking indicator alongside the readiness badge", () => {
    const html = render(baseCard({ readiness: "failed", reworking: true }));

    // Both indicators present.
    expect(html).toContain('data-readiness="failed"');
    expect(html).toContain("Reworking");
    expect(html).toContain("↺");
  });

  // The refused indicator MUST still render (M11c).
  it("still renders the refused indicator alongside the readiness badge", () => {
    const html = render(baseCard({ readiness: "stale", refused: true }));

    // Both indicators present.
    expect(html).toContain('data-readiness="stale"');
    expect(html).toContain("Settings refused at launch");
    expect(html).toContain("⚠");
  });

  // Orthogonality: readiness badge is independent of other card state.
  it("readiness badge is independent of card status (running/needs/queued/crashed)", () => {
    const statuses = ["running", "needs", "queued", "crashed"] as const;

    for (const status of statuses) {
      const html = render(baseCard({ status, readiness: "blocked" }));

      expect(html).toContain('data-readiness="blocked"');
    }
  });
});

// BREAKING CHANGES REFERENCE (for Implementor):
// Lines to REPLACE in flight-card.tsx:
//   - OLD lines 122-148: the three badge <span> blocks for mergeBlocked/evidenceStale/externalGatePending.
//   - NEW: single conditional <span> when readiness !== "ready" && !isDone.
//
// EXISTING TEST ASSERTIONS TO UPDATE:
// (Marked as REPLACING old 3-badge checks per contract)
// OLD (lines 111-123 of flight-card.test.ts):
//   - "renders the merge-blocked and evidence-stale badges when both flags are set"
//   - "omits both evidence badges when the flags are false"
// → REPLACE with assertions on the single readiness badge.
//
// OLD (lines 141-157 of flight-card.test.ts):
//   - "renders the external-gate-pending badge when the flag is set"
//   - "omits the external-gate-pending badge when the flag is false"
// → REPLACE with readiness badge assertions for "waiting" state.
//
// (These replacements are documented in the unit test suite above.)
