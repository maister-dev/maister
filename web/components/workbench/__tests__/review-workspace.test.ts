import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/runs/run-1",
  useSearchParams: () => new URLSearchParams("wb=review&scope=review"),
}));

import {
  ReviewWorkspace,
  ReviewWorkspaceUnavailable,
} from "@/components/workbench/review-workspace";

const DIFF_LABELS = {
  title: "Diff",
  empty: "No changes",
  error: "Diff failed",
  changedFiles: "Changed files",
  bodyUnavailable: "Body unavailable",
  added: "Added",
  removed: "Removed",
  displayMode: "Display",
  rich: "Rich",
  raw: "Raw",
  filterFiles: "Filter",
  filterFilesPlaceholder: "Filter files",
  filterNoMatches: "No matches",
  showFiles: "Show files",
  hideFiles: "Hide files",
  refresh: "Refresh",
  viewMode: "View",
  split: "Split",
  unified: "Unified",
  truncated: "Truncated",
};

const REVIEW = {
  currentUserId: "user-1",
  canComment: true,
  labels: {
    composerPlaceholder: "Comment",
    composerSubmit: "Submit",
    composerCancel: "Cancel",
    reply: "Reply",
    edit: "Edit",
    delete: "Delete",
    resolve: "Resolve",
    unresolve: "Unresolve",
    resolved: "Resolved",
    iteration: "Iteration $n",
    expand: "Expand",
    collapse: "Collapse",
    outdatedTitle: "Outdated",
    sideOld: "Old",
    sideNew: "New",
    error: "Error",
  },
};

describe("ReviewWorkspace", () => {
  it("composes the immutable review diff and its only decision rail", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        runId: "run-1",
        diffLabels: DIFF_LABELS,
        review: REVIEW,
        decision: createElement("button", { type: "button" }, "Approve"),
        labels: {
          title: "Review workspace",
          source: "Base to current working tree",
          decision: "Review decision",
        },
      }),
    );

    expect(html).toContain('data-testid="review-workspace"');
    expect(html).toContain("Base to current working tree");
    expect(html).toContain('data-testid="run-diff-loading"');
    expect(html).toContain("Review decision");
    expect(html).toContain("Approve");
  });

  it("makes a non-review deep link visibly unavailable", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewWorkspaceUnavailable, {
        message: "Review workspace unavailable",
      }),
    );

    expect(html).toContain('data-testid="review-workspace-unavailable"');
    expect(html).toContain("Review workspace unavailable");
  });
});
