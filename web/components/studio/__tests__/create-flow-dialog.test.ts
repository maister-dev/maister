import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const translations = vi.hoisted(() => {
  const createFlow = Object.assign(
    vi.fn((key: string) => key),
    {
      raw: vi.fn((key: string) => key),
    },
  );
  const local = vi.fn((key: string) => key);

  return { createFlow, local };
});

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) =>
    namespace === "studio.local.createFlow"
      ? translations.createFlow
      : translations.local,
}));

import { CreateFlowDialog } from "@/components/studio/create-flow-dialog";

describe("CreateFlowDialog", () => {
  beforeEach(() => {
    translations.createFlow.mockClear();
    translations.createFlow.raw.mockClear();
    translations.local.mockClear();
  });

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
    expect(translations.local).toHaveBeenCalledWith("cancel");
    expect(translations.createFlow).not.toHaveBeenCalledWith("cancel");
    expect(translations.createFlow.raw).toHaveBeenCalledWith("linksHint");
    expect(translations.createFlow.raw).toHaveBeenCalledWith("sourcesHint");
  });
});
