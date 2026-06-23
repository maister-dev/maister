import type { DiffViewLabels } from "@/components/workbench/diff-view";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import {
  ChangeReviewDialog,
  type ChangeReviewDialogLabels,
} from "@/components/studio/change-review-dialog";

const LABELS: ChangeReviewDialogLabels = {
  title: "Review changes",
  changed: "$count changed",
  clean: "No uncommitted changes.",
  loadError: "Could not load the diff.",
  messageLabel: "Commit message",
  messagePlaceholder: "Commit message (optional)",
  commit: "Commit",
  committing: "Committing…",
  cancel: "Cancel",
  invalidTitle: "Cannot commit — fix these artifacts:",
};

describe("ChangeReviewDialog", () => {
  it("renders the modal shell with the commit message + commit/cancel actions", () => {
    const html = renderToStaticMarkup(
      createElement(ChangeReviewDialog, {
        packageId: "p1",
        sessionId: "s1",
        labels: LABELS,
        // DiffView only mounts once the diff loads (an effect), which does not
        // run under renderToStaticMarkup — a stub label object is never read.
        diffViewLabels: {} as DiffViewLabels,
        onClose: () => {},
        onCommitted: () => {},
      }),
    );

    expect(html).toContain('data-testid="change-review-dialog"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('data-testid="change-review-commit"');
    expect(html).toContain('data-testid="change-review-message"');
    expect(html).toContain('data-testid="change-review-cancel"');
    expect(html).toContain("Review changes");
    // No diff has loaded yet (effects do not run) → the commit button is disabled.
    expect(html).toContain('data-testid="change-review-commit"');
    expect(html).toContain("disabled");
  });
});
