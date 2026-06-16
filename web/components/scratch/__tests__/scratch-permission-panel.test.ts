// Render-only smoke test (createElement + renderToStaticMarkup, no jsdom).
// next-intl is mocked to echo `namespace.key`.
import type { ScratchDetail } from "@/lib/scratch-runs/dialog";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

import { ScratchPermissionPanel } from "@/components/scratch/scratch-permission-panel";

type PendingHitl = NonNullable<ScratchDetail["pendingHitl"]>;

function render(pendingHitl: PendingHitl): string {
  return renderToStaticMarkup(
    createElement(ScratchPermissionPanel, {
      pendingHitl,
      pending: false,
      onAnswer: () => {},
    }),
  );
}

describe("ScratchPermissionPanel", () => {
  it("renders the prompt and option buttons for a permission request", () => {
    const html = render({
      hitlRequestId: "h1",
      kind: "permission",
      prompt: "Allow file write?",
      schema: null,
      options: [
        { optionId: "allow", label: "Allow" },
        { optionId: "deny", label: "Deny" },
      ],
    });

    expect(html).toContain('data-testid="scratch-permission-panel"');
    expect(html).toContain("Allow file write?");
    expect(html).toContain("Allow");
    expect(html).toContain("Deny");
  });

  it("renders a JSON editor for a form/human request", () => {
    const html = render({
      hitlRequestId: "h2",
      kind: "form",
      prompt: "Fill the form",
      schema: {},
      options: [],
    });

    expect(html).toContain("<textarea");
    expect(html).toContain("scratch.submit");
  });
});
