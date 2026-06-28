import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { AttachToProjectButton } from "@/components/studio/attach-to-project-button";

describe("AttachToProjectButton", () => {
  it("links already-attached projects and offers a one-click attach for the rest", () => {
    const html = renderToStaticMarkup(
      createElement(AttachToProjectButton, {
        defaultOpen: true,
        installId: "inst-1",
        triggerClassName: "x",
        targets: [
          { slug: "alpha", name: "Alpha", attached: true },
          { slug: "beta", name: "Beta", attached: false },
        ],
      }),
    );

    // Attached → a link to that project's packages tab; not the attach action.
    expect(html).toContain('href="/projects/alpha?tab=packages"');
    expect(html).toContain("attachAttached");
    expect(html).not.toContain('data-testid="attach-do-alpha"');
    // Not attached → a one-click attach button, no project link.
    expect(html).toContain('data-testid="attach-do-beta"');
    expect(html).not.toContain('href="/projects/beta?tab=packages"');
  });

  it("shows an empty state when the viewer manages no projects", () => {
    const html = renderToStaticMarkup(
      createElement(AttachToProjectButton, {
        defaultOpen: true,
        installId: "inst-1",
        triggerClassName: "x",
        targets: [],
      }),
    );

    expect(html).toContain('data-testid="attach-empty"');
  });
});
