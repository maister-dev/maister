import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  RunTimeline,
  type TimelineEntry,
  type TimelineLabels,
} from "@/components/board/run-timeline";

const labels: TimelineLabels = {
  title: "Timeline",
  staleGate: "stale",
  currentGate: "current",
  rerunRequired: "rerun required",
  handoff: "Manual takeover",
  claimedBy: "claimed by",
  elapsed: "elapsed",
  returnedCommits: "Returned commits",
  returnedDiff: "Returned diff",
  assignmentLedger: "Assignment ledger",
  assignmentActor: "unknown actor",
  assignmentSystemActor: "system",
  duration: "Duration",
  tokenTotal: "Token total",
  empty: "No attempts yet.",
  decisionLabel: (d) => (d === "approve" ? "Approve" : d),
};

const zeroTokens = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  total: 0,
};

function staleEntry(): TimelineEntry {
  return {
    nodeAttemptId: "na-stale",
    nodeId: "checks",
    nodeType: "check",
    attempt: 1,
    status: "Stale",
    decision: null,
    reworkFromNode: null,
    acpSessionId: null,
    startedAt: "2026-05-31T10:06:00.000Z",
    endedAt: "2026-05-31T10:07:00.000Z",
    durationMs: 60_000,
    tokens: zeroTokens,
    gates: [
      {
        gateId: "lint",
        kind: "command_check",
        mode: "blocking",
        status: "stale",
        verdict: { verdict: "pass" },
        stale: true,
        endedAt: null,
      },
    ],
    handoff: null,
  };
}

function freshEntry(): TimelineEntry {
  return {
    nodeAttemptId: "na-fresh",
    nodeId: "checks",
    nodeType: "check",
    attempt: 2,
    status: "Succeeded",
    decision: null,
    reworkFromNode: null,
    acpSessionId: null,
    startedAt: "2026-05-31T10:10:00.000Z",
    endedAt: "2026-05-31T10:11:00.000Z",
    durationMs: 60_000,
    tokens: zeroTokens,
    gates: [
      {
        gateId: "lint",
        kind: "command_check",
        mode: "blocking",
        status: "passed",
        verdict: { verdict: "pass" },
        stale: false,
        endedAt: null,
      },
    ],
    handoff: null,
  };
}

function handoffEntry(): TimelineEntry {
  return {
    nodeAttemptId: "na-takeover",
    nodeId: "review",
    nodeType: "human",
    attempt: 1,
    status: "NeedsInput",
    decision: null,
    reworkFromNode: null,
    acpSessionId: null,
    startedAt: "2026-05-31T10:08:00.000Z",
    endedAt: null,
    durationMs: null,
    tokens: zeroTokens,
    gates: [],
    handoff: {
      ownerUserId: "user-1",
      ownerName: "Reviewer Rae",
      ownerEmail: "rae@maister.local",
      baseRef: "base000",
      returnedCommits: "abc123 fix the thing",
      returnedDiff: "diff --git a/x b/x\n+changed line",
    },
  };
}

function render(entries: TimelineEntry[]): string {
  return renderToStaticMarkup(
    createElement(RunTimeline, {
      assignmentEvents: [],
      entries,
      labels,
    }),
  );
}

describe("RunTimeline component", () => {
  it("renders a stale gate distinctly from a current gate", () => {
    const html = render([staleEntry(), freshEntry()]);

    // The stale gate carries the rerun-required hint; the current one does not
    // get that hint applied to it.
    expect(html).toContain("rerun required");
    // A stale gate is struck/greyed — line-through utility present.
    expect(html).toContain("line-through");
    // Both gate ids appear.
    expect(html).toContain("lint");
  });

  it("renders the handoff block with owner, branch-agnostic commits and a plain <pre> diff", () => {
    const html = render([handoffEntry()]);

    expect(html).toContain("Manual takeover");
    expect(html).toContain("Reviewer Rae");
    expect(html).toContain("Returned commits");
    expect(html).toContain("abc123 fix the thing");
    expect(html).toContain("Returned diff");
    // Returned diff is a plain <pre> (no syntax highlighting per M9 deferral).
    expect(html).toContain("<pre");
    expect(html).toContain("+changed line");
  });

  it("renders an empty-but-valid timeline for a legacy linear run", () => {
    const html = render([]);

    expect(html).toContain("No attempts yet.");
  });

  it("renders assignment ledger history when no node attempt is present", () => {
    const html = renderToStaticMarkup(
      createElement(RunTimeline, {
        assignmentEvents: [
          {
            id: "event-1",
            assignmentId: "assignment-1",
            actionKind: "human_review",
            title: "Review assignment",
            eventKind: "system_closed",
            fromStatus: "claimed",
            toStatus: "cancelled",
            actorLabel: null,
            actorKind: "system",
            nodeId: "review",
            stepId: null,
            createdAt: "2026-06-02T09:00:00.000Z",
          },
        ],
        entries: [],
        labels,
      }),
    );

    expect(html).toContain("Assignment ledger");
    expect(html).toContain("system_closed");
    expect(html).toContain("human_review");
    expect(html).toContain("Review assignment");
    expect(html).toContain("system");
    expect(html).not.toContain("No attempts yet.");
    // T-C2: the ledger is collapsed by default — a <details> with no `open`.
    expect(html).toContain('data-testid="assignment-ledger"');
    expect(html).toMatch(/<details[^>]*data-testid="assignment-ledger"/);
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });
});
