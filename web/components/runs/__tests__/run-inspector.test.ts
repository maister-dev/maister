import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  RunInspector,
  type RunInspectorLabels,
} from "@/components/runs/run-inspector";

const LABELS: RunInspectorLabels = {
  overview: "Overview",
  changes: "Changes",
  flow: "Flow",
  actions: "Actions",
  noChanges: "No changes",
  unavailable: "Unavailable",
  viewDiff: "View diff",
  viewSource: "View source",
  binary: "Binary",
  disabled: "Disabled",
  stale: "May be stale",
};

function renderInspector(): string {
  return renderToStaticMarkup(
    createElement(RunInspector, {
      runId: "run-1",
      labels: LABELS,
      pathname: "/runs/run-1",
      search: "scope=run&file=README.md",
      facts: [
        { label: "Status", value: "Running" },
        { label: "Branch", value: "maister/run-1" },
      ],
      changeSummary: {
        fileCount: 2,
        additions: 7,
        deletions: 3,
        files: [
          {
            path: "src/app.ts",
            status: "M",
            additions: 5,
            deletions: 2,
          },
          {
            path: "README.md",
            status: "A",
            additions: 2,
            deletions: 1,
            binary: true,
          },
        ],
      },
      flowSummary: {
        title: "Flow",
        subtitle: "2 nodes",
        nodes: [
          {
            id: "implement",
            label: "Implement",
            status: "Running",
            current: true,
            durationLabel: "12s",
            tokenLabel: "1.2k tokens",
          },
        ],
      },
      actions: [
        {
          id: "review",
          label: "Open review",
          href: "/runs/run-1?wb=diff",
        },
        {
          id: "promote",
          label: "Promote",
          disabled: true,
          disabledReason: "Review first",
        },
      ],
    }),
  );
}

function renderDirtyInspector(): string {
  return renderToStaticMarkup(
    createElement(RunInspector, {
      runId: "run-1",
      labels: LABELS,
      pathname: "/runs/run-1",
      search: "scope=uncommitted",
      facts: [],
      changeSummary: {
        fileCount: 1,
        additions: 4,
        deletions: 0,
        dirty: true,
        files: [
          {
            path: ".ai-factory/PLAN.md",
            status: "A",
            additions: 4,
            deletions: 0,
          },
        ],
      },
      actions: [],
    }),
  );
}

describe("RunInspector", () => {
  it("renders the relocated capability/settings blocks (flowExtras) in the Flow tab", () => {
    const html = renderToStaticMarkup(
      createElement(RunInspector, {
        runId: "run-1",
        labels: LABELS,
        facts: [],
        changeSummary: null,
        flowSummary: null,
        actions: [],
        flowExtras: createElement(
          "div",
          { "data-testid": "moved-capability-block" },
          "Node settings",
        ),
      }),
    );

    expect(html).toContain('data-testid="flow-extras"');
    expect(html).toContain('data-testid="moved-capability-block"');
    expect(html).toContain("Node settings");
  });

  it("renders the four inspector tabs and overview facts", () => {
    const html = renderInspector();

    expect(html.split('role="tab"').length - 1).toBe(4);
    expect(html).toContain("Overview");
    expect(html).toContain("Changes");
    expect(html).toContain("Flow");
    expect(html).toContain("Actions");
    expect(html).toContain("maister/run-1");
  });

  it("links changed files to diffFile, not file", () => {
    const html = renderInspector();

    expect(html).toContain(
      'href="/runs/run-1?scope=run&amp;file=README.md&amp;wb=diff&amp;diffFile=src%2Fapp.ts"',
    );
  });

  it("links source shortcuts to the Files pane file parameter", () => {
    const html = renderInspector();

    expect(html).toContain(
      'href="/runs/run-1?scope=run&amp;file=src%2Fapp.ts&amp;wb=files&amp;fileView=source"',
    );
  });

  it("links dirty shortcuts to the Diff pane because untracked files have no git blob", () => {
    const html = renderDirtyInspector();

    expect(html).toContain("View diff");
    expect(html).toContain(
      'href="/runs/run-1?scope=uncommitted&amp;wb=diff&amp;diffFile=.ai-factory%2FPLAN.md"',
    );
    expect(html).not.toContain("fileView=source");
  });

  it("renders current flow node and disabled action state", () => {
    const html = renderInspector();

    expect(html).toContain('data-current="true"');
    expect(html).toContain("1.2k tokens");
    expect(html).toContain('data-disabled="true"');
    expect(html).toContain("Review first");
  });

  it("shows the stale badge only when a live refresh has failed", () => {
    expect(renderInspector()).not.toContain(
      'data-testid="run-inspector-stale"',
    );

    const staleHtml = renderToStaticMarkup(
      createElement(RunInspector, {
        runId: "run-1",
        labels: LABELS,
        facts: [],
        changeSummary: null,
        actions: [],
        stale: true,
      }),
    );

    expect(staleHtml).toContain('data-testid="run-inspector-stale"');
    expect(staleHtml).toContain("May be stale");
  });

  it("separates high-risk cleanup actions into a danger group", () => {
    const html = renderToStaticMarkup(
      createElement(RunInspector, {
        runId: "run-1",
        labels: LABELS,
        facts: [],
        changeSummary: null,
        actions: [
          { id: "promote", label: "Promote" },
          { id: "drop", label: "Discard" },
        ],
      }),
    );

    expect(html).toContain('data-testid="run-inspector-danger-actions"');
    // Both the normal (promote) and danger (drop) actions render as items.
    expect(html.split('data-testid="run-inspector-action"').length - 1).toBe(2);
  });
});
