// ADR-072 review-mode UI: render tests for the PRESENTATIONAL comment
// composer (textarea + submit/cancel). renderToStaticMarkup, no jsdom —
// mirrors components/board/__tests__/hitl-decision-controls.test.ts.
// Interactivity (typing, submit callbacks) is asserted structurally:
// presence of controls, labels, disabled states.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ReviewCommentComposer } from "@/components/workbench/review-comment-composer";

const LABELS = {
  placeholder: "review.composerPlaceholder",
  submit: "review.submit",
  cancel: "review.cancel",
};

type ComposerProps = Parameters<typeof ReviewCommentComposer>[0];

function render(over: Partial<ComposerProps> = {}): string {
  const base: ComposerProps = {
    labels: LABELS,
    onSubmit: vi.fn(),
  };

  return renderToStaticMarkup(
    createElement(ReviewCommentComposer, { ...base, ...over }),
  );
}

describe("ReviewCommentComposer — inline comment composer (ADR-072)", () => {
  it("renders a textarea with the translated placeholder", () => {
    const html = render();

    expect(html).toContain('data-testid="review-composer-input"');
    expect(html).toContain('placeholder="review.composerPlaceholder"');
  });

  it("renders the submit button with its label", () => {
    const html = render();

    expect(html).toContain('data-testid="review-composer-submit"');
    expect(html).toContain("review.submit");
  });

  it("renders the cancel button only when onCancel is provided", () => {
    const withCancel = render({ onCancel: vi.fn() });
    const withoutCancel = render();

    expect(withCancel).toContain('data-testid="review-composer-cancel"');
    expect(withCancel).toContain("review.cancel");
    expect(withoutCancel).not.toContain('data-testid="review-composer-cancel"');
  });

  // The disabled ATTRIBUTE renders as `disabled=""` — a bare "disabled"
  // substring would also match the Tailwind `disabled:opacity-50` class.
  it("disables submit while the draft is empty", () => {
    const html = render();
    const submit = html.match(/<button[^>]*review-composer-submit[^>]*>/u);

    expect(submit?.[0]).toContain('disabled=""');
  });

  it("carries initialValue into the textarea and enables submit", () => {
    const html = render({ initialValue: "Original body text" });

    expect(html).toContain("Original body text");

    const submit = html.match(/<button[^>]*review-composer-submit[^>]*>/u);

    expect(submit?.[0]).not.toContain('disabled=""');
  });

  it("disables the textarea and buttons when busy", () => {
    const html = render({
      busy: true,
      initialValue: "draft",
      onCancel: vi.fn(),
    });
    const textarea = html.match(/<textarea[^>]*>/u);
    const submit = html.match(/<button[^>]*review-composer-submit[^>]*>/u);
    const cancel = html.match(/<button[^>]*review-composer-cancel[^>]*>/u);

    expect(textarea?.[0]).toContain('disabled=""');
    expect(submit?.[0]).toContain('disabled=""');
    expect(cancel?.[0]).toContain('disabled=""');
  });
});
