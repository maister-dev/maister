// ADR-072 review-mode UI: render tests for the PRESENTATIONAL collapsible
// "Outdated" thread list shown below the diff (file:line + quoted stale
// line_content + the same thread card incl. resolve).
// renderToStaticMarkup, no jsdom.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OutdatedThreadsSection } from "@/components/workbench/outdated-threads";
import {
  type ReviewCommentDto,
  type ReviewCommentsLabels,
  type ReviewThread,
  type ReviewThreadActions,
} from "@/components/workbench/review-thread-card";

const LABELS: ReviewCommentsLabels = {
  composerPlaceholder: "review.composerPlaceholder",
  composerSubmit: "review.submit",
  composerCancel: "review.cancel",
  reply: "review.reply",
  edit: "review.edit",
  delete: "review.delete",
  resolve: "review.resolve",
  unresolve: "review.unresolve",
  resolved: "review.resolved",
  iteration: "Iteration $n",
  expand: "review.expand",
  collapse: "review.collapse",
  outdatedTitle: "review.outdatedTitle",
  sideOld: "review.sideOld",
  sideNew: "review.sideNew",
};

function makeActions(): ReviewThreadActions {
  return {
    onReply: vi.fn(),
    onEdit: vi.fn(),
    onSetStatus: vi.fn(),
    onDelete: vi.fn(),
  };
}

function comment(over: Partial<ReviewCommentDto> = {}): ReviewCommentDto {
  return {
    id: "c-root-1",
    runId: "run-1",
    hitlRequestId: "hitl-1",
    nodeId: "review",
    gateAttempt: 1,
    parentId: null,
    authorUserId: "user-a",
    authorLabel: "Alice Reviewer",
    filePath: "src/stale.ts",
    side: "old",
    line: 33,
    lineContent: "legacyCall(arg);",
    body: "This call must go away.",
    status: "open",
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: "2026-06-10T10:00:00.000Z",
    updatedAt: null,
    ...over,
  };
}

function outdatedThread(over: Partial<ReviewThread> = {}): ReviewThread {
  return { root: comment(), placement: "outdated", replies: [], ...over };
}

type SectionProps = Parameters<typeof OutdatedThreadsSection>[0];

function render(over: Partial<SectionProps> = {}): string {
  const base: SectionProps = {
    threads: [outdatedThread()],
    currentUserId: "user-a",
    canComment: true,
    labels: LABELS,
    actions: makeActions(),
  };

  return renderToStaticMarkup(
    createElement(OutdatedThreadsSection, { ...base, ...over }),
  );
}

describe("OutdatedThreadsSection — collapsible outdated list (ADR-072)", () => {
  it("renders a collapsible details block with the translated title and count", () => {
    const html = render();

    expect(html).toContain('data-testid="outdated-threads"');
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("review.outdatedTitle");
    expect(html).toContain("(1)");
  });

  it("renders the file:line anchor with the translated side label", () => {
    const html = render();

    expect(html).toContain('data-testid="outdated-anchor"');
    expect(html).toContain("src/stale.ts:33");
    expect(html).toContain("review.sideOld");
  });

  it("uses the new-side label for a new-side anchor", () => {
    const html = render({
      threads: [outdatedThread({ root: comment({ side: "new", line: 7 }) })],
    });

    expect(html).toContain("review.sideNew");
  });

  it("quotes the stale line_content snapshot", () => {
    const html = render();

    expect(html).toContain('data-testid="outdated-quote"');
    expect(html).toContain("legacyCall(arg);");
  });

  it("renders the full thread card with resolve available there", () => {
    const html = render();

    expect(html).toContain('data-testid="review-thread"');
    expect(html).toContain("Alice Reviewer");
    expect(html).toContain("This call must go away.");
    expect(html).toContain('data-testid="review-thread-resolve"');
  });

  it("lists ONLY outdated threads — inline placements are filtered out", () => {
    const html = render({
      threads: [
        outdatedThread(),
        {
          root: comment({ id: "c-inline", body: "Inline remark" }),
          placement: "inline",
          replies: [],
        },
      ],
    });
    const count = html.split('data-testid="outdated-thread-entry"').length - 1;

    expect(count).toBe(1);
    expect(html).not.toContain("Inline remark");
  });

  it("renders nothing when there are no outdated threads", () => {
    const html = render({
      threads: [
        {
          root: comment({ id: "c-inline", body: "Inline remark" }),
          placement: "inline",
          replies: [],
        },
      ],
    });

    expect(html).toBe("");
  });
});
