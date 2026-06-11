import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TimelineItem } from "@/lib/queries/task-detail";

import { TaskTimeline } from "@/components/social/task-timeline";

const labels = {
  empty: "Nothing yet",
  formerUser: "former user",
  system: "system",
  event: {
    task_created: "created this task",
    run_launched: "launched run attempt %attempt%",
    relation_added: "added a relation to %ref%",
  },
};

const at = new Date("2026-06-11T10:00:00Z");

describe("TaskTimeline", () => {
  it("renders the empty state", () => {
    const html = renderToStaticMarkup(
      createElement(TaskTimeline, { items: [], labels }),
    );

    expect(html).toContain("Nothing yet");
  });

  it("interleaves comment cards and activity rows in given order", () => {
    const items: TimelineItem[] = [
      {
        kind: "activity",
        id: "a1",
        eventKind: "task_created",
        payload: {},
        actor: { type: "user", id: "u1", label: "Alice" },
        createdAt: at,
      },
      {
        kind: "comment",
        id: "c1",
        body: "see [MAI-2](/projects/maister/tasks/2)",
        actor: { type: "user", id: "u2", label: "Bob" },
        createdAt: at,
      },
    ];
    const html = renderToStaticMarkup(
      createElement(TaskTimeline, { items, labels }),
    );

    expect(html.indexOf("created this task")).toBeLessThan(
      html.indexOf("MAI-2"),
    );
    // Expanded mention renders as a real markdown link.
    expect(html).toContain('href="/projects/maister/tasks/2"');
    expect(html).toContain("Alice");
    expect(html).toContain("Bob");
  });

  it("substitutes payload refs and renders system/former-user labels", () => {
    const items: TimelineItem[] = [
      {
        kind: "activity",
        id: "a2",
        eventKind: "run_launched",
        payload: { runId: "r1", attemptNumber: 3 },
        actor: { type: "system", id: null, label: "system" },
        createdAt: at,
      },
      {
        kind: "activity",
        id: "a3",
        eventKind: "relation_added",
        payload: { toRef: "MAI-9" },
        actor: { type: "user", id: "gone", label: "former user" },
        createdAt: at,
      },
    ];
    const html = renderToStaticMarkup(
      createElement(TaskTimeline, { items, labels }),
    );

    expect(html).toContain("launched run attempt 3");
    expect(html).toContain("added a relation to MAI-9");
    expect(html).toContain("system");
    expect(html).toContain("former user");
  });

  it("renders raw HTML in comment bodies as text (remark-only, no rehype-raw)", () => {
    const items: TimelineItem[] = [
      {
        kind: "comment",
        id: "c2",
        body: "<script>alert(1)</script>",
        actor: { type: "user", id: "u1", label: "Alice" },
        createdAt: at,
      },
    ];
    const html = renderToStaticMarkup(
      createElement(TaskTimeline, { items, labels }),
    );

    expect(html).not.toContain("<script>");
  });
});
