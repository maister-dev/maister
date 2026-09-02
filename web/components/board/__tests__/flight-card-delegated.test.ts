import type { FlightCard as FlightCardData } from "@/lib/queries/board";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  FlightCard,
  type FlightCardLabels,
} from "@/components/board/flight-card";

// ADR-163: a delegated child's in-flight / review card names its orchestrator
// task (the `parent_of` SOURCE), so an operator reading the board can tell a
// coordinator's child from a user task without opening the task detail.

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
  prChip: {
    open: "PR open",
    merged: "PR merged",
    closed: "PR closed",
    conflicts: "Conflicts",
    reopen: "Reopen",
  },
  runsCount: (count: number) => `${count} runs`,
  launch: "Run again",
  launchUnavailable: "Unavailable",
  unconfigured: "no flow",
  needsAttention: "Needs you",
  openRun: "Open run",
  delegatedBy: "delegated by",
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
    prState: null,
    prHasConflicts: null,
    crashAction: null,
    blockedBy: [],
    childTasks: [],
    ...over,
  } as FlightCardData;
}

function render(card: FlightCardData): string {
  return renderToStaticMarkup(
    createElement(FlightCard, { canAct: false, card, labels, slug: "proj" }),
  );
}

describe("FlightCard — delegated-child provenance (ADR-163)", () => {
  it("renders the parent chip linking to the orchestrator's task", () => {
    const html = render(
      baseCard({
        parentTask: { keyRef: "TST-3", number: 3, projectSlug: "proj" },
      }),
    );

    expect(html).toContain('data-testid="flight-card-delegated-by"');
    expect(html).toContain("delegated by");
    expect(html).toContain("TST-3");
    expect(html).toContain('href="/projects/proj/tasks/3"');
  });

  it("renders no chip on a task with no parent", () => {
    expect(render(baseCard({ parentTask: null }))).not.toContain(
      "flight-card-delegated-by",
    );
  });
});
