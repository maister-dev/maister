import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { CreateFlowDialog } from "@/components/studio/create-flow-dialog";

describe("CreateFlowDialog", () => {
  it("uses the one Flow-specific wizard for package creation and exposes every required metadata field", () => {
    const html = renderToStaticMarkup(
      createElement(CreateFlowDialog, {
        mode: "new-package",
        busy: false,
        requestError: null,
        onClose: () => {},
        onSubmit: async () => {},
      }),
    );

    expect(html).toContain('data-testid="create-flow-dialog"');
    expect(html).toContain('data-testid="create-flow-package-name"');
    expect(html).toContain('data-testid="create-flow-id"');
    expect(html).toContain('data-testid="create-flow-title"');
    expect(html).toContain('data-testid="create-flow-summary"');
    expect(html).toContain('data-testid="create-flow-route-when"');
    expect(html).toContain('data-testid="create-flow-submit"');
    expect(html).not.toMatch(/frontmatter/i);
  });
});
