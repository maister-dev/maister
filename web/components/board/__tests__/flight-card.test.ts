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
  evidenceStale: "Evidence stale",
  mergeBlocked: "Merge blocked",
  // M16 Phase 7: external_check gate-readiness badge label.
  externalGatePending: "External gate pending",
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
    evidenceStale: false,
    mergeBlocked: false,
    externalGatePending: false,
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

describe("FlightCard — evidence badges (M12)", () => {
  it("renders the merge-blocked and evidence-stale badges when both flags are set", () => {
    const html = render(baseCard({ evidenceStale: true, mergeBlocked: true }));

    // The merge-blocked chip carries the translated label as aria-label/title.
    expect(html).toContain('aria-label="Merge blocked"');
    expect(html).toContain('title="Merge blocked"');
    // The evidence-stale chip carries the translated label as aria-label/title.
    expect(html).toContain('aria-label="Evidence stale"');
    expect(html).toContain('title="Evidence stale"');
    // The glyphs themselves render.
    expect(html).toContain("◆");
    expect(html).toContain("≈");
  });

  it("omits both evidence badges when the flags are false", () => {
    const html = render(
      baseCard({ evidenceStale: false, mergeBlocked: false }),
    );

    expect(html).not.toContain("Merge blocked");
    expect(html).not.toContain("Evidence stale");
    expect(html).not.toContain("◆");
    expect(html).not.toContain("≈");
  });
});

// T7.7 (RED): the external_check gate-pending badge (M16 Phase 7), rendered
// like the existing evidence badges — a distinct glyph (◉, not already used by
// ◆/≈/↺/⚠) with the translated label threaded into aria-label + title. The
// `externalGatePending` field/label do not exist yet → RED (badge absent).
describe("FlightCard — external gate badge (M16 Phase 7)", () => {
  it("renders the external-gate-pending badge when the flag is set", () => {
    const html = render(baseCard({ externalGatePending: true }));

    expect(html).toContain('aria-label="External gate pending"');
    expect(html).toContain('title="External gate pending"');
    // A distinct glyph not already taken by ◆/≈/↺/⚠.
    expect(html).toContain("◉");
  });

  it("omits the external-gate-pending badge when the flag is false", () => {
    const html = render(baseCard({ externalGatePending: false }));

    expect(html).not.toContain("External gate pending");
    expect(html).not.toContain("◉");
  });
});
