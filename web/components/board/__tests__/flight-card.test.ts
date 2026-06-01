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
