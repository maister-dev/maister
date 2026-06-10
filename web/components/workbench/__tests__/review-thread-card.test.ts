// ADR-071 review-mode UI: render tests for the PRESENTATIONAL thread card
// (root + replies + icon-only RBAC actions + resolved collapse) and the
// ReviewThreadStack used as the diff renderExtendLine body.
// renderToStaticMarkup, no jsdom — mirrors
// components/board/__tests__/hitl-decision-controls.test.ts.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ReviewThreadCard,
  ReviewThreadStack,
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
    gateAttempt: 2,
    parentId: null,
    authorUserId: "user-a",
    authorLabel: "Alice Reviewer",
    filePath: "src/a.ts",
    side: "new",
    line: 14,
    lineContent: "const x = 1;",
    body: "Rename this variable.",
    status: "open",
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: "2026-06-10T10:00:00.000Z",
    updatedAt: null,
    ...over,
  };
}

function thread(over: Partial<ReviewThread> = {}): ReviewThread {
  return { root: comment(), placement: "inline", replies: [], ...over };
}

type CardProps = Parameters<typeof ReviewThreadCard>[0];

function render(over: Partial<CardProps> = {}): string {
  const base: CardProps = {
    thread: thread(),
    currentUserId: "user-a",
    canComment: true,
    labels: LABELS,
    actions: makeActions(),
  };

  return renderToStaticMarkup(
    createElement(ReviewThreadCard, { ...base, ...over }),
  );
}

describe("ReviewThreadCard — open thread (ADR-071)", () => {
  it("renders the root author label and body", () => {
    const html = render();

    expect(html).toContain("Alice Reviewer");
    expect(html).toContain("Rename this variable.");
  });

  it("renders the iteration badge with the gateAttempt number and label", () => {
    const html = render();

    expect(html).toContain('data-testid="review-iteration-badge"');
    expect(html).toContain('aria-label="Iteration 2"');
    expect(html).toContain(">2<");
  });

  it("renders icon-only reply and resolve buttons with translated aria-labels", () => {
    const html = render();

    expect(html).toContain('aria-label="review.reply"');
    expect(html).toContain('aria-label="review.resolve"');
    expect(html).toContain('data-testid="review-thread-reply"');
    expect(html).toContain('data-testid="review-thread-resolve"');
  });

  it("renders edit and delete for the author", () => {
    const html = render({ currentUserId: "user-a" });

    expect(html).toContain('aria-label="review.edit"');
    expect(html).toContain('aria-label="review.delete"');
  });

  it("hides edit and delete for a non-author", () => {
    const html = render({ currentUserId: "user-b" });

    expect(html).not.toContain('data-testid="review-thread-edit"');
    expect(html).not.toContain('data-testid="review-thread-delete"');
    expect(html).toContain('data-testid="review-thread-reply"');
    expect(html).toContain('data-testid="review-thread-resolve"');
  });

  it("hides edit and delete when the author account was deleted (null author)", () => {
    const html = render({
      thread: thread({ root: comment({ authorUserId: null }) }),
      currentUserId: "user-a",
    });

    expect(html).not.toContain('data-testid="review-thread-edit"');
    expect(html).not.toContain('data-testid="review-thread-delete"');
  });

  it("hides ALL mutating actions when canComment is false", () => {
    const html = render({ canComment: false });

    expect(html).not.toContain('data-testid="review-thread-reply"');
    expect(html).not.toContain('data-testid="review-thread-resolve"');
    expect(html).not.toContain('data-testid="review-thread-edit"');
    expect(html).not.toContain('data-testid="review-thread-delete"');
    // The thread itself stays readable.
    expect(html).toContain("Rename this variable.");
  });

  it("hides reply edit/delete for the reply author when canComment is false", () => {
    const html = render({
      thread: thread({
        replies: [
          comment({
            id: "c-reply-1",
            parentId: "c-root-1",
            authorUserId: "user-b",
            authorLabel: "Bob Author",
            body: "Done.",
            filePath: null,
            side: null,
            line: null,
            lineContent: null,
          }),
        ],
      }),
      currentUserId: "user-b",
      canComment: false,
    });

    expect(html).not.toContain('data-testid="review-reply-edit"');
    expect(html).not.toContain('data-testid="review-reply-delete"');
    // The reply itself stays readable.
    expect(html).toContain("Done.");
  });

  it("does not render the resolved marker or unresolve action on an open thread", () => {
    const html = render();

    expect(html).not.toContain("review.resolved");
    expect(html).not.toContain('data-testid="review-thread-unresolve"');
  });

  it("disables action buttons when busy", () => {
    const html = render({ busy: true });
    const reply = html.match(/<button[^>]*review-thread-reply[^>]*>/u);

    // The ATTRIBUTE (`disabled=""`), not the `disabled:opacity-50` class.
    expect(reply?.[0]).toContain('disabled=""');
  });

  it("renders replies with their author labels and bodies", () => {
    const html = render({
      thread: thread({
        replies: [
          comment({
            id: "c-reply-1",
            parentId: "c-root-1",
            authorUserId: "user-b",
            authorLabel: "Bob Author",
            body: "Done in the next push.",
            filePath: null,
            side: null,
            line: null,
            lineContent: null,
          }),
        ],
      }),
    });

    expect(html).toContain('data-testid="review-reply"');
    expect(html).toContain("Bob Author");
    expect(html).toContain("Done in the next push.");
  });

  it("renders reply edit/delete only for the reply author", () => {
    const replies = [
      comment({
        id: "c-reply-1",
        parentId: "c-root-1",
        authorUserId: "user-b",
        authorLabel: "Bob Author",
        body: "Done.",
        filePath: null,
        side: null,
        line: null,
        lineContent: null,
      }),
    ];
    const asReplyAuthor = render({
      thread: thread({ replies }),
      currentUserId: "user-b",
    });
    const asStranger = render({
      thread: thread({ replies }),
      currentUserId: "user-c",
    });

    expect(asReplyAuthor).toContain('data-testid="review-reply-edit"');
    expect(asReplyAuthor).toContain('data-testid="review-reply-delete"');
    expect(asStranger).not.toContain('data-testid="review-reply-edit"');
    expect(asStranger).not.toContain('data-testid="review-reply-delete"');
  });
});

describe("ReviewThreadCard — resolved thread (ADR-071)", () => {
  const resolvedThread = thread({
    root: comment({ status: "resolved", resolvedByUserId: "user-b" }),
  });

  it("renders the resolved marker and data-status", () => {
    const html = render({ thread: resolvedThread });

    expect(html).toContain("review.resolved");
    expect(html).toContain('data-status="resolved"');
  });

  it("collapses the body by default and offers an expand toggle", () => {
    const html = render({ thread: resolvedThread });

    expect(html).not.toContain("Rename this variable.");
    expect(html).toContain('data-testid="review-thread-toggle"');
    expect(html).toContain('aria-label="review.expand"');
  });

  it("offers unresolve instead of resolve", () => {
    const html = render({ thread: resolvedThread });

    expect(html).toContain('data-testid="review-thread-unresolve"');
    expect(html).toContain('aria-label="review.unresolve"');
    expect(html).not.toContain('data-testid="review-thread-resolve"');
  });

  it("hides unresolve when canComment is false", () => {
    const html = render({ thread: resolvedThread, canComment: false });

    expect(html).not.toContain('data-testid="review-thread-unresolve"');
  });
});

describe("ReviewThreadStack — renderExtendLine body (ADR-071)", () => {
  it("renders one card per thread", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewThreadStack, {
        threads: [
          thread(),
          thread({ root: comment({ id: "c-root-2", body: "Second remark" }) }),
        ],
        currentUserId: "user-a",
        canComment: true,
        labels: LABELS,
        actions: makeActions(),
      }),
    );
    const count = html.split('data-testid="review-thread"').length - 1;

    expect(count).toBe(2);
    expect(html).toContain('data-testid="review-inline-threads"');
    expect(html).toContain("Second remark");
  });

  it("renders nothing for an empty thread list", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewThreadStack, {
        threads: [],
        currentUserId: null,
        canComment: false,
        labels: LABELS,
        actions: makeActions(),
      }),
    );

    expect(html).toBe("");
  });
});
