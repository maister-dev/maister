import type { ReadinessState } from "@/lib/flows/graph/readiness-core";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReadinessSummary } from "@/components/run/readiness-summary";

type ReadinessSummaryProps = {
  state: ReadinessState;
  reasons: string[];
  labels: {
    state: Record<ReadinessState, string>;
    summary: string;
    reasons: string;
  };
};

const baseLabels: ReadinessSummaryProps["labels"] = {
  state: {
    ready: "Ready",
    blocked: "Blocked",
    stale: "Stale",
    failed: "Failed",
    waiting: "Waiting",
    overridden: "Overridden",
  },
  summary: "Readiness",
  reasons: "Reasons",
};

function render(props: ReadinessSummaryProps): string {
  return renderToStaticMarkup(createElement(ReadinessSummary, props));
}

describe("ReadinessSummary — readiness state display (M15)", () => {
  it("renders the ready state with its label and data-readiness attribute", () => {
    const html = render({
      state: "ready",
      reasons: [],
      labels: baseLabels,
    });

    expect(html).toContain("Ready");
    expect(html).toContain('data-readiness="ready"');
    // Accessible badge should have aria-label or title with the state label.
    expect(html).toMatch(/(?:aria-label|title)="Ready"/);
  });

  it("renders the blocked state with its label and data-readiness attribute", () => {
    const html = render({
      state: "blocked",
      reasons: [],
      labels: baseLabels,
    });

    expect(html).toContain("Blocked");
    expect(html).toContain('data-readiness="blocked"');
  });

  it("renders the stale state with its label and data-readiness attribute", () => {
    const html = render({
      state: "stale",
      reasons: [],
      labels: baseLabels,
    });

    expect(html).toContain("Stale");
    expect(html).toContain('data-readiness="stale"');
  });

  it("renders the failed state with its label and data-readiness attribute", () => {
    const html = render({
      state: "failed",
      reasons: [],
      labels: baseLabels,
    });

    expect(html).toContain("Failed");
    expect(html).toContain('data-readiness="failed"');
  });

  it("renders the waiting state with its label and data-readiness attribute", () => {
    const html = render({
      state: "waiting",
      reasons: [],
      labels: baseLabels,
    });

    expect(html).toContain("Waiting");
    expect(html).toContain('data-readiness="waiting"');
  });

  it("renders the overridden state with its label and data-readiness attribute", () => {
    const html = render({
      state: "overridden",
      reasons: [],
      labels: baseLabels,
    });

    expect(html).toContain("Overridden");
    expect(html).toContain('data-readiness="overridden"');
  });

  it("renders the summary heading with the labels.summary text", () => {
    const html = render({
      state: "ready",
      reasons: [],
      labels: baseLabels,
    });

    expect(html).toContain("Readiness");
  });

  it("renders all reasons when reasons array is non-empty", () => {
    const reasons = [
      'blocking gate "linter" failed',
      'required artifact "cov-report" is stale',
      'blocking gate "merge-safety" is skipped',
    ];
    const html = render({
      state: "failed",
      reasons,
      labels: baseLabels,
    });

    // React auto-escapes double quotes in text children to &quot; (house
    // convention: plain auto-escaped child, never dangerouslySetInnerHTML).
    for (const reason of reasons) {
      expect(html).toContain(reason.replaceAll('"', "&quot;"));
    }
  });

  it("omits the reasons list when reasons array is empty", () => {
    const html = render({
      state: "ready",
      reasons: [],
      labels: baseLabels,
    });

    // The reasons heading should not appear when the list is empty.
    expect(html).not.toContain("Reasons");
  });

  it("shows the summary heading and state badge for blocked state with multiple reasons", () => {
    const html = render({
      state: "blocked",
      reasons: [
        'required artifact "config" has no current row',
        'blocking gate "smoke" is skipped — not passed/overridden',
      ],
      labels: baseLabels,
    });

    expect(html).toContain("Readiness");
    expect(html).toContain("Blocked");
    expect(html).toContain('data-readiness="blocked"');
    expect(html).toContain(
      "required artifact &quot;config&quot; has no current row",
    );
    expect(html).toContain("blocking gate &quot;smoke&quot; is skipped");
  });

  it("preserves state badge across all states even with many reasons", () => {
    const allStates: ReadinessState[] = [
      "ready",
      "blocked",
      "stale",
      "failed",
      "waiting",
      "overridden",
    ];

    for (const state of allStates) {
      const html = render({
        state,
        reasons: Array.from({ length: 3 }, (_, i) => `reason ${i + 1}`),
        labels: baseLabels,
      });

      expect(html).toContain(`data-readiness="${state}"`);
    }
  });
});
