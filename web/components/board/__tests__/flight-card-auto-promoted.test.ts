import type { FlightCard as FlightCardData } from "@/lib/queries/board";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

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
  readiness: {
    ready: "Ready",
    blocked: "Blocked",
    stale: "Stale",
    failed: "Failed",
    waiting: "Waiting",
    overridden: "Overridden",
  },
  readyToPromote: "Ready to promote",
  autoPromoted: (lane: string) => `Auto-promoted via the ${lane} lane`,
  runsCount: (count: number) => `${count} runs`,
  launch: "Run again",
  launchUnavailable: "Unavailable",
  unconfigured: "no flow",
  needsAttention: "Needs you",
  flagged: "Needs review",
  waitingOnChildren: "Waiting on children",
  openRun: "Open run",
  activeNodeStatus: {
    running: "running",
    needs: "needs input",
    failed: "failed",
    waiting: "waiting",
  },
  decomposition: {
    title: (count: number) => `Decomposition (${count})`,
    noRun: "no run",
    status: {
      Pending: "Pending",
      Running: "Running",
      NeedsInput: "Needs input",
      NeedsInputIdle: "Needs input · idle",
      HumanWorking: "Human working",
      WaitingOnChildren: "Waiting on children",
      Review: "Review",
      Crashed: "Crashed",
      Done: "Done",
      Abandoned: "Abandoned",
      Failed: "Failed",
    },
  },
};

function baseCard(over: Partial<FlightCardData> = {}): FlightCardData {
  return {
    taskId: "task-1",
    number: 1,
    keyRef: "TST-1",
    title: "Bump docs",
    flowRef: "bugfix",
    taskPriority: "normal",
    queuePaused: false,
    runCount: 1,
    runStatus: "Done",
    triageStatus: null,
    runId: "run-1",
    agent: "claude",
    status: "done",
    stepLabel: "promote",
    spine: Array.from({ length: 7 }, () => ({ state: "done" as const })),
    time: "1m",
    reworking: false,
    owner: null,
    refused: false,
    crashAction: null,
    lifecycleActions: [],
    readiness: "ready",
    readyToPromote: false,
    prNumber: null,
    autoPromotedLane: null,
    blockedBy: [],
    childTasks: [],
    activeNode: null,
    ...over,
  };
}

function render(card: FlightCardData): string {
  return renderToStaticMarkup(
    createElement(FlightCard, { canAct: false, card, labels, slug: "proj" }),
  );
}

describe("FlightCard — auto-promoted glyph (ADR-126, T19)", () => {
  it("renders the auto glyph with the lane in the tooltip when autoPromotedLane is set", () => {
    const html = render(baseCard({ autoPromotedLane: "docs" }));

    expect(html).toContain('data-testid="flight-card-auto-promoted"');
    expect(html).toContain("auto");
    // The lane is carried in the accessible name / tooltip.
    expect(html).toContain('title="Auto-promoted via the docs lane"');
    expect(html).toContain('aria-label="Auto-promoted via the docs lane"');
  });

  it("omits the auto glyph when autoPromotedLane is null (manual/pending run)", () => {
    const html = render(baseCard({ autoPromotedLane: null }));

    expect(html).not.toContain('data-testid="flight-card-auto-promoted"');
    expect(html).not.toContain("Auto-promoted via");
  });

  it("carries the specific lane class through to the tooltip", () => {
    const html = render(baseCard({ autoPromotedLane: "deps" }));

    expect(html).toContain('title="Auto-promoted via the deps lane"');
  });
});
