// ADR-177 D2/D3/D4/D8 — the overview table's render contract.
//
// Every numeric run cell is a LINK into the ledger; the count and the list it
// opens are the same number by construction (the SQL fragment), and this suite
// pins the other half: that the link actually carries project, kind, bucket and
// the day bounds.

import type { OverviewTable as OverviewTableModel } from "@/lib/queries/observatory-overview";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";
import { labelsForTest } from "@/components/observatory/__tests__/labels.fixture";
import { OverviewCostStrip } from "@/components/observatory/overview-cost-strip";
import { OverviewTable } from "@/components/observatory/overview-table";
import { ObservatoryViews } from "@/components/observatory/observatory-views";
import {
  QualityFlowsTable,
  QualityProjectsTable,
} from "@/components/observatory/quality-tables";
import { emptyOverviewCounts } from "@/lib/queries/observatory-overview";
import { parseObservatorySearchParams } from "@/lib/observatory/filters";

const NOW = new Date("2026-06-05T12:00:00.000Z");
const labels = labelsForTest();
const current = parseObservatorySearchParams({}, NOW).current;

function counts(
  overrides: Partial<{
    tasksInWork: number;
    tasksStarted: number;
    runs: Partial<Record<"flow" | "scratch" | "agent", number>>;
    buckets: Partial<Record<string, number>>;
  }> = {},
) {
  const base = emptyOverviewCounts();

  return {
    ...base,
    tasksInWork: overrides.tasksInWork ?? 0,
    tasksStarted: overrides.tasksStarted ?? 0,
    runs: { ...base.runs, ...overrides.runs },
    buckets: { ...base.buckets, ...overrides.buckets },
  };
}

function table(
  overrides: Partial<OverviewTableModel> = {},
): OverviewTableModel {
  return {
    rows: [
      {
        key: "project:maister",
        identity: {
          kind: "project",
          projectId: "p1",
          projectSlug: "maister",
          projectName: "MAIster",
        },
        counts: counts({
          tasksInWork: 14,
          tasksStarted: 9,
          runs: { flow: 22, scratch: 9, agent: 3 },
          buckets: { Delivered: 15, Review: 3, Failed: 4 },
        }),
      },
    ],
    platform: null,
    subRows: [],
    totals: counts({
      tasksInWork: 14,
      tasksStarted: 9,
      runs: { flow: 22, scratch: 9, agent: 3 },
      buckets: { Delivered: 15, Review: 3, Failed: 4 },
    }),
    volatile: false,
    ...overrides,
  };
}

function render(
  model: OverviewTableModel,
  extra: { projectSlug?: string; liveLabel?: string | null } = {},
): string {
  return renderToStaticMarkup(
    createElement(OverviewTable, { current, labels, table: model, ...extra }),
  );
}

describe("OverviewTable", () => {
  it("renders the grouped headers and every bucket column", () => {
    const html = render(table());

    for (const heading of [
      labels.overview.tasks,
      labels.overview.runs,
      labels.overview.inFlight,
      labels.overview.settled,
    ]) {
      expect(html).toContain(heading);
    }
    for (const bucket of Object.values(labels.bucket)) {
      expect(html).toContain(bucket);
    }
  });

  it("renders a project row, its counts and a totals row", () => {
    const html = render(table());

    expect(html).toContain("MAIster");
    expect(html).toContain('data-testid="observatory-overview-total"');
    expect(html).toContain(labels.overview.total);
    expect(html).toContain(">14<");
    expect(html).toContain(">22<");
  });

  it("links every run cell into the ledger with kind, bucket and the day bounds", () => {
    const html = render(table());

    expect(html).toContain(
      "/runs?project=maister&amp;kind=flow&amp;from=2026-05-07&amp;to=2026-06-05",
    );
    expect(html).toContain(
      "/runs?project=maister&amp;bucket=Delivered&amp;from=2026-05-07&amp;to=2026-06-05",
    );
    // Task cells go to the board, not the ledger.
    expect(html).toContain('href="/projects/maister"');
  });

  it("renders the Platform row only when present, with empty task cells", () => {
    expect(render(table())).not.toContain(labels.overview.platform);

    const html = render(
      table({
        platform: {
          key: "__platform__",
          identity: { kind: "platform" },
          counts: counts({ runs: { scratch: 4 }, buckets: { ResultOnly: 3 } }),
        },
      }),
    );

    expect(html).toContain(labels.overview.platform);
    // Em dash in both task cells rather than a misleading zero.
    expect(html).toContain("—");
    // The platform row's cells never carry a project param.
    expect(html).toContain("/runs?kind=scratch&amp;from=2026-05-07");
  });

  it("renders the empty state when the period holds no run", () => {
    const html = render(
      table({
        rows: [],
        totals: counts(),
      }),
    );

    expect(html).toContain(labels.overview.empty);
    expect(html).not.toContain("<table");
  });

  it("renders the live band only when the page supplies one", () => {
    expect(render(table())).not.toContain(
      'data-testid="observatory-overview-live"',
    );
    expect(
      render(table({ volatile: true }), { liveLabel: "live · 2 runs" }),
    ).toContain("live · 2 runs");
  });

  it("scrolls inside its own container rather than dropping columns", () => {
    const html = render(table());

    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("min-w-[1080px]");
    // No responsive column hiding — the paired th/td class defect class.
    expect(html).not.toMatch(/class="[^"]*\bhidden\b[^"]*"/);
  });

  it("renders flow and run-kind sub-rows on a project page", () => {
    const html = render(
      table({
        subRows: [
          {
            key: "flow:bugfix",
            identity: { kind: "flow", flowRefId: "bugfix" },
            counts: counts({ runs: { flow: 2 }, buckets: { Executing: 2 } }),
          },
          {
            key: "kind:scratch",
            identity: { kind: "runKind", runKind: "scratch" },
            counts: counts({ runs: { scratch: 1 } }),
          },
        ],
      }),
      { projectSlug: "maister" },
    );

    expect(html).toContain("bugfix");
    expect(html).toContain(labels.overview.kind.scratch);
    // A run-kind sub-row narrows the ledger link to that kind.
    expect(html).toContain("kind=scratch&amp;bucket=Queued");
  });

  it("leaves sub-row task cells empty — the breakdown splits runs, not tasks", () => {
    const html = render(
      table({
        rows: [],
        subRows: [
          {
            key: "kind:scratch",
            identity: { kind: "runKind", runKind: "scratch" },
            // Task counts never reach a sub-row; a zero here would read as
            // "this kind touched no tasks" rather than "no task axis".
            counts: counts({ runs: { scratch: 3 } }),
          },
        ],
        totals: counts({ runs: { scratch: 3 } }),
      }),
      { projectSlug: "maister" },
    );
    const firstRow = html.slice(html.indexOf("<tbody>"));

    expect(firstRow).toContain("—");
    // The board link belongs to a project row, never to a sub-row.
    expect(firstRow.slice(0, firstRow.indexOf("/runs?"))).not.toContain(
      'href="/projects/maister"',
    );
  });

  it("does not link a FLOW sub-row's cells — the ledger cannot filter by flow", () => {
    const html = render(
      table({
        rows: [],
        subRows: [
          {
            key: "flow:bugfix",
            identity: { kind: "flow", flowRefId: "bugfix" },
            counts: counts({ runs: { flow: 2 }, buckets: { Executing: 2 } }),
          },
        ],
        totals: counts({ runs: { flow: 2 }, buckets: { Executing: 2 } }),
      }),
      { projectSlug: "maister" },
    );

    // AC4: a cell's count equals the list it opens. A flow cell has no list
    // that matches it, so it opens none rather than a wrong one.
    expect(html).toContain("bugfix");
    expect(html).not.toContain("bucket=Executing");
  });

  it("renders RU bucket labels from the shared runBucket namespace", () => {
    const ruLabels = labelsForTest(
      ru.observatory as Record<string, unknown>,
      ru.runBucket as Record<string, unknown>,
    );
    const html = renderToStaticMarkup(
      createElement(OverviewTable, {
        current,
        labels: ruLabels,
        table: table(),
      }),
    );

    expect(html).toContain(ru.runBucket.Delivered);
    expect(html).toContain(ru.observatory.overview.title);
    // The EN word may still appear as the `bucket=` VALUE in a href; what must
    // not appear is an EN column HEADER.
    expect(html).not.toContain(`>${en.runBucket.Delivered}<`);
    expect(html).toContain(`>${ru.runBucket.Delivered}<`);
  });
});

describe("OverviewCostStrip", () => {
  const cost = {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    resumeTokens: 0,
    totalTokens: 150,
    projectCount: 1,
    flowCount: 1,
    nodeCount: 1,
    byModel: [
      row("model-a", 100),
      row("model-b", 30),
      row("model-c", 15),
      row("model-d", 5),
    ],
    byRunner: [row("claude/sonnet", 150)],
    byFlow: [row("bugfix", 120), row("scratch", 30)],
    byKind: [],
  };

  function row(key: string, totalTokens: number) {
    return {
      key,
      label: key,
      inputTokens: totalTokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens,
    };
  }

  it("shows the period total, the top three per dimension, and a link to Cost", () => {
    const html = renderToStaticMarkup(
      createElement(OverviewCostStrip, {
        cost,
        current,
        labels,
        locale: "en",
        pathname: "/observatory",
      }),
    );

    expect(html).toContain("150");
    expect(html).toContain(labels.costBreakdown.byFlowTitle);
    expect(html).toContain("bugfix");
    expect(html).toContain("model-c");
    // Top three only.
    expect(html).not.toContain("model-d");
    expect(html).toContain("/observatory?view=cost&amp;windowDays=30");
  });
});

describe("ObservatoryViews", () => {
  it("renders four href tabs and marks the active one", () => {
    const html = renderToStaticMarkup(
      createElement(ObservatoryViews, {
        current: parseObservatorySearchParams({ view: "cost" }, NOW).current,
        labels,
        pathname: "/observatory",
      }),
    );

    for (const view of ["overview", "cost", "quality", "harness"]) {
      expect(html).toContain(`data-testid="observatory-view-${view}"`);
      expect(html).toContain(`/observatory?view=${view}&amp;windowDays=30`);
    }
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('role="tablist"');
  });
});

describe("Quality tables", () => {
  const metric = {
    correction: {
      runCount: 5,
      reworkCount: 2,
      retryCount: 1,
      correctionRate: 0.6,
      displayKind: "pressure-ratio" as const,
      volatile: false,
      runIds: [],
    },
    autonomy: {
      totalSeconds: 3600,
      waitSeconds: 600,
      openWaitCount: 0,
      autonomyScore: 0.83,
      volatile: false,
      reviewDwellExcluded: true as const,
      runIds: [],
    },
  };

  it("renders one row per project, linking to that project's Quality view", () => {
    const html = renderToStaticMarkup(
      createElement(QualityProjectsTable, {
        labels,
        projects: [
          {
            projectId: "p1",
            projectSlug: "maister",
            projectName: "MAIster",
            ...metric,
          },
        ],
      }),
    );

    expect(html).toContain('data-testid="observatory-quality-projects"');
    expect(html).toContain("MAIster");
    expect(html).toContain("/projects/maister/observatory?view=quality");
    expect(html).toContain("0.60");
    expect(html).toContain("0.83");
    expect(html).toContain("10m");
  });

  it("renders one row per flow on the project page", () => {
    const html = renderToStaticMarkup(
      createElement(QualityFlowsTable, {
        flows: [{ flowId: "f1", flowRefId: "bugfix", ...metric }],
        labels,
      }),
    );

    expect(html).toContain('data-testid="observatory-quality-flows"');
    expect(html).toContain("bugfix");
  });

  it("renders an empty state rather than a headerless table", () => {
    const html = renderToStaticMarkup(
      createElement(QualityFlowsTable, { flows: [], labels }),
    );

    expect(html).toContain(labels.noNodes);
    expect(html).not.toContain("<table");
  });
});
