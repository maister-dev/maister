import type { ContextSnapshot } from "@/lib/runs/context-snapshot";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { expect, it } from "vitest";

import en from "../../../messages/en.json";

import { ContextUsageMeter } from "@/components/runs/context-usage-meter";

it.each([
  [0, "0%", "bg-accent-4", 0],
  [599, "59.9%", "bg-accent-4", 599],
  [600, "60%", "bg-amber", 600],
  [850, "85%", "bg-danger", 850],
  [1200, "120%", "bg-danger", 1000],
] as const)(
  "renders measured usage %i at the right threshold with accessible bounds",
  (used, percentage, band, ariaValue) => {
    const snapshot: ContextSnapshot = {
      type: "session.context_snapshot",
      runId: "test",
      nodeAttemptId: null,
      runSessionId: "logical",
      incarnationId: "physical",
      lifecycleSequence: "1",
      contextSequence: "2",
      transcriptSequence: null,
      usage: {
        used,
        size: 1000,
        sizeSource: "agent_reported",
        observedAt: "2026-11-20T06:00:00Z",
        sourceSequence: "2",
      },
      activeCompactions: 0,
      completedCompactions: 0,
      coverage: "from_incarnation_start",
      windowAdvisory: null,
    };
    const rendered = renderToStaticMarkup(
      createElement(NextIntlClientProvider, {
        locale: "en",
        messages: { contextUsage: en.contextUsage },
        timeZone: "UTC",
        // eslint-disable-next-line react-jsx/no-children-prop -- Provider props require children in the non-JSX renderer.
        children: createElement(ContextUsageMeter, { snapshot }),
      }),
    );

    expect(rendered).toContain('role="meter"');
    expect(rendered).toContain(`aria-valuenow="${ariaValue}"`);
    expect(rendered).toContain(`aria-valuetext="${percentage}`);
    expect(rendered).toContain(band);
  },
);
