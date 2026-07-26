import type { TimelineItem } from "@/lib/queries/task-detail";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TaskTimeline } from "@/components/social/task-timeline";

const labels = {
  empty: "Nothing yet",
  formerUser: "former user",
  system: "system",
  mentionNotSummonable: "%agents% will not run — no mention trigger.",
  event: {
    task_created: "created this task",
    run_launched: "launched run attempt %attempt%",
    relation_added: "added a relation to %ref%",
    agent_summon_suppressed:
      "skipped summoning %agent% — it is already working here",
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

// ADR-151 — the two explanations a reader needs. A successful summon gets no
// row at all (the run is the evidence); only the two failure-ish states speak.
describe("TaskTimeline agent mentions (ADR-151)", () => {
  it("footnotes ONLY the resolved mentions that cannot summon", () => {
    const items: TimelineItem[] = [
      {
        kind: "comment",
        id: "c1",
        body: "ping",
        actor: { type: "user", id: "u1", label: "Alice" },
        createdAt: at,
        mentionedAgents: [
          { id: "core:triager", name: "Triager", summonable: true },
          { id: "core:reviewer", name: "Reviewer", summonable: false },
        ],
      },
    ];
    const html = renderToStaticMarkup(
      createElement(TaskTimeline, { items, labels }),
    );

    expect(html).toContain("core:reviewer");
    expect(html).toContain("will not run");
    // The summonable one needs no explanation — its run is the evidence.
    expect(html).not.toContain("core:triager");
  });

  it("renders no footnote when every mention is summonable", () => {
    const items: TimelineItem[] = [
      {
        kind: "comment",
        id: "c1",
        body: "ping",
        actor: { type: "user", id: "u1", label: "Alice" },
        createdAt: at,
        mentionedAgents: [
          { id: "core:triager", name: "Triager", summonable: true },
        ],
      },
    ];
    const html = renderToStaticMarkup(
      createElement(TaskTimeline, { items, labels }),
    );

    expect(html).not.toContain("will not run");
  });

  it("renders a suppressed summon as its own row naming the agent", () => {
    const items: TimelineItem[] = [
      {
        kind: "activity",
        id: "a1",
        eventKind: "agent_summon_suppressed",
        payload: { agentId: "core:triager", triggerEventId: "42" },
        actor: { type: "system", id: null, label: "system" },
        createdAt: at,
      },
    ];
    const html = renderToStaticMarkup(
      createElement(TaskTimeline, { items, labels }),
    );

    expect(html).toContain("skipped summoning core:triager");
    expect(html).toContain("already working here");
  });
});
