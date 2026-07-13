import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ConfirmDialogFrame,
  type ConfirmDialogFrameProps,
} from "@/components/feedback/confirm-dialog-frame";

function render(busy: boolean): string {
  const props: ConfirmDialogFrameProps = {
    body: "Discard local changes?",
    busy,
    cancelLabel: "Cancel",
    children: createElement(
      "button",
      { disabled: busy, type: "button" },
      "Discard",
    ),
    testId: "discard-confirm",
    title: "Discard changes",
    titleId: "discard-confirm-title",
    onClose: () => {},
  };

  return renderToStaticMarkup(createElement(ConfirmDialogFrame, props));
}

describe("ConfirmDialogFrame", () => {
  it("renders an accessible labelled dialog with a cancellation backdrop", () => {
    const html = render(false);

    expect(html).toContain('data-testid="discard-confirm"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="discard-confirm-title"');
    expect(html).toContain('aria-label="Cancel"');
    expect(html).toContain("Discard local changes?");
  });

  it("locks dismissal and confirmation controls while the request is busy", () => {
    const html = render(true);

    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });
});
