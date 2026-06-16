import type { FlightCard as FlightCardData } from "@/lib/queries/board";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  FlightCard,
  type FlightCardLabels,
} from "@/components/board/flight-card";

// ---------------------------------------------------------------------------
// CONTRACT under test — M11c Phase 4.3 board card refused indicator.
//
// When the latest run had a node whose settings were `refused` at launch, the
// in-flight / review card shows a minimal indicator linking to the run-detail
// settings panel. This mirrors the existing M11a `reworking` indicator:
//
//   - `FlightCard` (lib/queries/board.ts) gains `refused: boolean`.
//   - `FlightCardLabels` (components/board/flight-card.tsx) gains
//     `settingsRefused: string` (the indicator's title / aria-label).
//   - The card renders a small refused badge iff `card.refused === true`.
//
// MUST NOT regress the M11a reworking badge nor the M11b takeover surface.
// RED now because `refused` is not on FlightCard and `settingsRefused` is not
// on FlightCardLabels.
// ---------------------------------------------------------------------------

const labels: FlightCardLabels = {
  reworking: "Reworking",
  claimedBy: "claimed by",
  takeoverReturn: "Return",
  elapsed: "elapsed",
  // M11c Phase 4.3 — new label, RED until the implementor adds it.
  settingsRefused: "Settings refused at launch",
  readiness: {
    ready: "Ready",
    blocked: "Blocked",
    stale: "Stale",
    failed: "Failed",
    waiting: "Waiting",
    overridden: "Overridden",
  },
  readyToPromote: "Ready to promote",
  runsCount: (count: number) => `${count} runs`,
  launch: "Run again",
  launchUnavailable: "Unavailable",
  unconfigured: "no flow",
  needsAttention: "Needs you",
  openRun: "Open run",
} as FlightCardLabels;

function baseCard(over: Partial<FlightCardData> = {}): FlightCardData {
  return {
    taskId: "task-1",
    number: 1,
    keyRef: "TST-1",
    title: "Fix the thing",
    flowRef: "bugfix",
    runCount: 1,
    runStatus: "Running",
    runId: "run-1",
    agent: "claude",
    status: "running",
    stepLabel: "implement",
    spine: Array.from({ length: 7 }, () => ({ state: "todo" as const })),
    time: "3m",
    reworking: false,
    owner: null,
    // M11c Phase 4.3 — refused indicator under test.
    refused: true,
    // T15 (M15): unified readiness state — "ready" so the badge stays hidden,
    // keeping this suite focused on the refused indicator.
    readiness: "ready",
    // M27 (main, merged): workbench lifecycle actions — none for this suite.
    lifecycleActions: [],
    readyToPromote: false,
    prNumber: null,
    crashAction: null,
    blockedBy: [],
    ...over,
  } as FlightCardData;
}

function render(card: FlightCardData): string {
  return renderToStaticMarkup(
    createElement(FlightCard, { canAct: false, card, labels, slug: "proj" }),
  );
}

describe("FlightCard — M11c refused-settings indicator (Phase 4.3)", () => {
  it("renders the refused indicator when card.refused is true", () => {
    const html = render(baseCard({ refused: true }));

    expect(html).toContain("Settings refused at launch");
  });

  it("does NOT render the refused indicator when card.refused is false", () => {
    const html = render(baseCard({ refused: false }));

    expect(html).not.toContain("Settings refused at launch");
  });

  it("does not regress the M11a reworking indicator", () => {
    const html = render(baseCard({ refused: false, reworking: true }));

    expect(html).toContain("Reworking");
    expect(html).toContain("↺");
  });

  it("does not regress the M11b takeover surface (claimed-by + Return)", () => {
    const html = render(
      baseCard({
        refused: false,
        status: "humanworking",
        agent: "dev",
        owner: "Reviewer Rae",
      }),
    );

    expect(html).toContain("claimed by");
    expect(html).toContain("Reviewer Rae");
    expect(html).toContain("Return");
  });
});
