import type { TaskActivityLogRow } from "@/lib/queries/activity";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TaskActivityLog } from "@/components/board/panels/task-activity-log";

const labels = {
  title: "Task log",
  empty: "No task activity yet.",
  colWhen: "When",
  colTask: "Task",
  colEvent: "Event",
  colActor: "Actor",
  colDetails: "Details",
  filterActor: "Actor",
  filterEvent: "Event",
  filterTask: "Task",
  filterAny: "any",
  apply: "Apply",
  pagePrev: "← prev",
  pageNext: "next →",
  pageInfo: "page {page} / {pages}",
  formerUser: "former user",
  system: "system",
  eventKind: { relation_added: "relation added", run_launched: "run launched" },
};

function row(over: Partial<TaskActivityLogRow> = {}): TaskActivityLogRow {
  return {
    id: "a1",
    keyRef: "MAI-3",
    taskNumber: 3,
    taskTitle: "A task",
    eventKind: "relation_added",
    actor: { type: "user", id: "u1", label: "Alice" },
    payload: { toRef: "MAI-9" },
    createdAt: new Date("2026-06-11T09:00:00Z"),
    ...over,
  };
}

describe("TaskActivityLog (read-only view-table)", () => {
  it("renders rows with KEY-N links, actor labels, payload details, and filters", () => {
    const html = renderToStaticMarkup(
      createElement(TaskActivityLog, {
        slug: "maister",
        rows: [
          row(),
          row({
            id: "a2",
            eventKind: "run_launched",
            payload: { attemptNumber: 2 },
            actor: { type: "system", id: null, label: "system" },
          }),
        ],
        total: 2,
        page: 1,
        pageSize: 50,
        filters: {},
        labels,
      }),
    );

    expect(html).toContain('href="/projects/maister/tasks/3"');
    expect(html).toContain("MAI-3");
    expect(html).toContain("relation added");
    expect(html).toContain("→ MAI-9");
    expect(html).toContain("#2");
    expect(html).toContain("Alice");
    expect(html).toContain("system");
    // URL-synchronized filters live in a plain GET form on the activity tab.
    expect(html).toContain('name="actor_type"');
    expect(html).toContain('name="event_kind"');
    expect(html).toContain('name="task"');
    expect(html).toContain('value="activity"');
    // No mutate affordances — view-only table.
    expect(html).not.toContain("delete");
  });

  it("renders pagination links preserving filters", () => {
    const html = renderToStaticMarkup(
      createElement(TaskActivityLog, {
        slug: "maister",
        rows: [row()],
        total: 120,
        page: 2,
        pageSize: 50,
        filters: { eventKind: "relation_added" },
        labels,
      }),
    );

    expect(html).toContain("page 2 / 3");
    expect(html).toContain("event_kind=relation_added");
    expect(html).toContain("page=3");
  });

  it("renders the empty state", () => {
    const html = renderToStaticMarkup(
      createElement(TaskActivityLog, {
        slug: "maister",
        rows: [],
        total: 0,
        page: 1,
        pageSize: 50,
        filters: {},
        labels,
      }),
    );

    expect(html).toContain("No task activity yet.");
  });
});
