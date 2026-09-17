// The activity row — does it name what it is about? (ADR-174 D4)
//
// This component had NO test. The defect that motivated one: a row whose task
// join is absent renders time + kind + actor + a generic "open run" label +
// the project name, and names its subject nowhere. That is not information, and
// it hits `run.crashed` — the highest-signal kind in the feed — because a
// crashed run often has no task joined to it.
//
// The second contract here is negative and just as important: chronology is the
// feed's point, so nothing may collapse, group or reorder rows.

import type { ActivityFeedRow } from "@/lib/queries/activity-feed";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActivityRowList } from "@/components/activity/activity-row-list";

const NOW = new Date("2026-09-17T12:00:00.000Z");

const labels = {
  kinds: { "run.crashed": "Run crashed", "task.created": "Task created" },
  divider: "NEW",
  openTask: "Open the task",
  openRun: "Open the run",
  openProject: "Open the project",
  webhookAttempts: "$count attempts",
};

function row(over: Partial<ActivityFeedRow> = {}): ActivityFeedRow {
  return {
    id: "event-1",
    source: "domain_event" as ActivityFeedRow["source"],
    kind: "run.crashed" as ActivityFeedRow["kind"],
    occurredAt: NOW,
    projectId: "project-1",
    projectSlug: "myapp",
    projectName: "MyApp",
    actor: null,
    taskId: null,
    taskKey: null,
    taskNumber: null,
    taskTitle: null,
    runId: null,
    gateId: null,
    hitlRequestId: null,
    webhook: null,
    ...over,
  };
}

function render(rows: ActivityFeedRow[]): string {
  return renderToStaticMarkup(
    createElement(ActivityRowList, {
      divider: false,
      labels,
      locale: "en",
      now: NOW,
      seen: rows,
      unread: [],
    }),
  );
}

describe("T-D19 every row names its subject", () => {
  it("names the task when one is joined", () => {
    const html = render([
      row({ taskKey: "MYAPP-12", taskNumber: 12, taskTitle: "Fix the login" }),
    ]);

    expect(html).toContain("MYAPP-12");
    expect(html).toContain("Fix the login");
  });

  it("falls back to a short run id when no task is joined", () => {
    // The `run.crashed` shape: a run died, no task join. Before this, the row
    // said "Run crashed … Open the run … MyApp" and never said WHICH run.
    const html = render([
      row({ runId: "3f2a1b8c-9d4e-4f01-8a2b-77c1e5d0a9f3" }),
    ]);

    // Asserted as rendered TEXT, not as a substring: the run id is already in
    // the href, so `toContain("3f2a1b8c")` alone passes against the unfixed
    // component and proves nothing.
    expect(html).toMatch(/>3f2a1b8c[^<]*</u);
    expect(html).not.toMatch(/>Open the run</u);
    // Still a link to the run, and still carrying its accessible name.
    expect(html).toContain('href="/runs/3f2a1b8c-9d4e-4f01-8a2b-77c1e5d0a9f3"');
    expect(html).toContain('title="Open the run"');
  });

  it("does not spend the run id on a row that already names its task", () => {
    // Two identifiers for one row is noise; the task is the better name.
    const html = render([
      row({
        runId: "3f2a1b8c-9d4e-4f01-8a2b-77c1e5d0a9f3",
        taskKey: "MYAPP-12",
        taskNumber: 12,
      }),
    ]);

    expect(html).toMatch(/>MYAPP-12</u);
    expect(html).not.toMatch(/>3f2a1b8c[^<]*</u);
  });

  it("falls back when a task key arrives without the number its link needs", () => {
    // The task link renders only when BOTH are present, so a key with no number
    // is a row that names nothing — the same defect by a narrower path.
    const html = render([
      row({
        taskKey: "MYAPP-12",
        taskNumber: null,
        runId: "3f2a1b8c-9d4e-4f01-8a2b-77c1e5d0a9f3",
      }),
    ]);

    expect(html).toMatch(/>3f2a1b8c[^<]*</u);
  });
});

describe("T-D20 chronology is the feed's contract", () => {
  it("renders rows in INPUT order, not in timestamp order", () => {
    // The read model owns the ordering; the component must not re-sort. Given
    // deliberately out-of-order input, a component that sorted would "fix" it
    // and quietly disagree with `/activity`.
    const rows = [
      row({ id: "a", occurredAt: new Date("2026-09-17T09:00:00.000Z") }),
      row({ id: "b", occurredAt: new Date("2026-09-17T11:00:00.000Z") }),
      row({ id: "c", occurredAt: new Date("2026-09-17T10:00:00.000Z") }),
    ];
    const html = render(rows);
    // Positional rather than clever: the three `dateTime` attributes, in the
    // order they were rendered. React emits the camelCase spelling.
    const stamps = [...html.matchAll(/dateTime="([^"]+)"/gu)].map((m) => m[1]);

    expect(stamps).toEqual(rows.map((entry) => entry.occurredAt.toISOString()));
  });

  it("collapses nothing — repeated identical events all render", () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      row({
        id: `dup-${index}`,
        runId: "3f2a1b8c-9d4e-4f01-8a2b-77c1e5d0a9f3",
      }),
    );
    const html = render(rows);

    expect(html.split('data-testid="activity-row"').length - 1).toBe(5);
  });
});
