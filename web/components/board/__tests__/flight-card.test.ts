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
  // M18 Phase 4: ready-to-promote / PR badge label.
  readyToPromote: "Ready to promote",
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
    title: "Fix the thing",
    flowRef: "bugfix",
    taskPriority: "normal",
    queuePaused: false,
    runCount: 1,
    runStatus: "Running",
    triageStatus: null,
    runId: "run-1",
    agent: "claude",
    status: "running",
    stepLabel: "implement",
    spine: Array.from({ length: 7 }, () => ({ state: "todo" as const })),
    time: "3m",
    reworking: false,
    owner: null,
    refused: false,
    crashAction: null,
    lifecycleActions: [],
    readiness: "ready",
    readyToPromote: false,
    prNumber: null,
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

describe("FlightCard — humanworking takeover surface (M11b)", () => {
  it("renders owner, elapsed, and a Return action for a humanworking card (no branch)", () => {
    const html = render(
      baseCard({
        status: "humanworking",
        agent: "dev",
        owner: "Reviewer Rae",
        time: "12m",
      }),
    );

    // Owner is shown via the "claimed by <owner>" badge.
    expect(html).toContain("claimed by");
    expect(html).toContain("Reviewer Rae");
    // The compact card no longer renders the worktree branch anywhere.
    expect(html).not.toContain("maister/");
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
    // The current node label still renders on row 2.
    expect(html).toContain("implement");
  });
});

describe("FlightCard — WaitingOnChildren orchestrator (M37, T1.2 affordance)", () => {
  it("renders a distinct waiting badge + accent-2 stripe, not a plain running card", () => {
    const html = render(baseCard({ status: "waiting" }));

    // The required distinct affordance: a dedicated badge + label.
    expect(html).toContain('data-testid="flight-card-waiting"');
    expect(html).toContain("Waiting on children");
    // Distinct stripe tone (accent-2), not the accent-4 Running stripe.
    expect(html).toContain("bg-accent-2");
  });

  it("a running card shows NO waiting badge (the two are visually distinct)", () => {
    const html = render(baseCard({ status: "running" }));

    expect(html).not.toContain('data-testid="flight-card-waiting"');
    expect(html).not.toContain("Waiting on children");
  });
});

describe("FlightCard — overall spine and active node status", () => {
  it("keeps completed spine progress separate from the active-node status chip", () => {
    const html = render(
      baseCard({
        activeNode: { label: "tests", state: "failed" },
        spine: [
          { state: "done" },
          { state: "active", tone: "failed" },
          { state: "todo" },
        ],
        stepLabel: "tests",
      }),
    );

    expect(html).toContain('data-active-node-state="failed"');
    expect(html).toContain("tests");
    expect(html).toContain("failed");
    expect(html).toContain('data-spine-state="done"');
    expect(html).toContain('data-spine-state="active"');
    expect(html).toContain('data-spine-tone="failed"');
  });

  it("pulses the active segment with the current node tone, including NeedsInput", () => {
    const html = render(
      baseCard({
        activeNode: { label: "review", state: "needs" },
        status: "needs",
        spine: [
          { state: "done" },
          { state: "active", tone: "needs" },
          { state: "todo" },
        ],
        stepLabel: "review",
      }),
    );

    expect(html).toContain('data-active-node-state="needs"');
    expect(html).toContain('data-spine-tone="needs"');
    expect(html).toContain("animate-[pulse-seg_2.4s_ease-out_infinite]");
  });
});

describe("FlightCard — workbench lifecycle actions", () => {
  it("renders shared lifecycle controls for a Review workbench", () => {
    const html = render(
      baseCard({
        status: "running",
        stepLabel: "review",
        lifecycleActions: ["archive", "drop", "exportBranch"],
      }),
    );

    expect(html).toContain("workbenchLifecycle.action.archive");
    expect(html).toContain("workbenchLifecycle.action.drop");
    expect(html).toContain("workbenchLifecycle.action.exportBranch");
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

// M18 Phase 4 (T4.4): the ready-to-promote / PR badge. A flow run at Review
// that is promotable shows a distinct accent-4 chip carrying the translated
// label as aria-label/title; with a pre-seeded `prNumber` it shows `PR #N`,
// otherwise the ↗ glyph.
describe("FlightCard — ready-to-promote / PR badge (M18 Phase 4)", () => {
  it("renders the ready-to-promote badge (↗) when readyToPromote and no PR", () => {
    const html = render(baseCard({ readyToPromote: true, prNumber: null }));

    expect(html).toContain('aria-label="Ready to promote"');
    expect(html).toContain('title="Ready to promote"');
    expect(html).toContain("↗");
  });

  it("renders the PR number (PR #4242) when readyToPromote and a prNumber", () => {
    const html = render(baseCard({ readyToPromote: true, prNumber: 4242 }));

    expect(html).toContain('aria-label="Ready to promote"');
    expect(html).toContain("PR #4242");
    // The plain ↗ glyph is replaced by the PR label when a number is present.
    expect(html).not.toContain("↗");
  });

  it("omits the badge when readyToPromote is false", () => {
    const html = render(baseCard({ readyToPromote: false, prNumber: 4242 }));

    expect(html).not.toContain("Ready to promote");
    expect(html).not.toContain("PR #4242");
    expect(html).not.toContain("↗");
  });
});

describe("FlightCard — compact identity-first contract", () => {
  it("links KEY-N to the task page and stretches a link to the run", () => {
    const html = render(baseCard());

    // KEY-N anchors to the task detail page (render prop slug = "proj").
    expect(html).toContain('href="/projects/proj/tasks/1"');
    // The whole card is a stretched link to the run.
    expect(html).toContain('data-testid="flight-card-open"');
    expect(html).toContain('href="/runs/run-1"');
  });

  it("shows task identity (KEY-N + title + flow) instead of the branch", () => {
    const html = render(
      baseCard({ title: "Make timeout configurable", flowRef: "bugfix" }),
    );

    expect(html).toContain("TST-1");
    expect(html).toContain("Make timeout configurable");
    expect(html).toContain("bugfix");
    // The worktree branch is never rendered on the compact card.
    expect(html).not.toContain("maister/");
  });

  it("renders no inline HITL form and no vestigial diff block", () => {
    const html = render(baseCard({ status: "needs" }));

    expect(html).not.toContain("<textarea");
    expect(html).not.toContain('data-testid="flight-card-hitl"');
    // The old `+X / −Y` diff block is gone.
    expect(html).not.toMatch(/\+\d+\s*\/\s*−\d+/);
  });

  it("flags a needs card with a needs-attention badge, not a form", () => {
    const html = render(baseCard({ status: "needs" }));

    expect(html).toContain('data-testid="flight-card-needs"');
    expect(html).toContain("Needs you");
  });

  it("uses a <div> container (no outer anchor wrapping the card)", () => {
    const html = render(baseCard());

    expect(html).toMatch(/^<div [^>]*data-testid="flight-card"/);
  });
});
