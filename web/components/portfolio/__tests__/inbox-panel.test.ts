import type { LegacyInboxItemView } from "@/lib/queries/inbox";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

// Client component using useRouter — mock the app-router hook for static render.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { InboxPanel } from "@/components/portfolio/inbox-panel";

const labels = {
  title: "Inbox",
  ariaLabel: "Unread task notifications",
  readAll: "Mark all read",
  readAllBusy: "Marking…",
  empty: "No unread notifications.",
  company: "Company",
  run: "Run",
  eventKind: { comment_added: "comment", task_mentioned: "mention" },
};

function item(over: Partial<LegacyInboxItemView> = {}): LegacyInboxItemView {
  return {
    id: "i1",
    projectSlug: "maister",
    projectName: "MAIster",
    taskNumber: 7,
    taskTitle: "Fix the parser",
    displayStatus: { key: "ready", label: "Ready", tone: "success" },
    keyRef: "MAI-7",
    eventKind: "comment_added",
    read: false,
    createdAt: new Date("2026-06-11T10:00:00Z"),
    ...over,
  };
}

describe("InboxPanel", () => {
  it("renders the count badge, rows with KEY-N links, and the read-all button", () => {
    const html = renderToStaticMarkup(
      createElement(InboxPanel, {
        items: [item(), item({ id: "i2", eventKind: "task_mentioned" })],
        count: 2,
        labels,
      }),
    );

    expect(html).toContain("Inbox");
    expect(html).toContain(">2<");
    expect(html).toContain('href="/projects/maister/tasks/7"');
    expect(html).toContain("MAI-7");
    expect(html).toContain("Fix the parser");
    expect(html).toContain("comment");
    expect(html).toContain("mention");
    expect(html).toContain("Mark all read");
  });

  it("renders the empty state without the read-all button", () => {
    const html = renderToStaticMarkup(
      createElement(InboxPanel, { items: [], count: 0, labels }),
    );

    expect(html).toContain("No unread notifications.");
    expect(html).not.toContain("Mark all read");
  });
});
