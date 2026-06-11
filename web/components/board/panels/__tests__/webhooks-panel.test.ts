import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Mirrors mcp-servers-panel.test.ts: identity-key i18n + stubbed navigation. The
// effect-driven list fetch does not run under server rendering, so the panel
// renders its initial empty state; canWrite gating is what we assert here.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/projects/demo",
}));

import { WebhooksPanel } from "@/components/board/panels/webhooks-panel";

describe("board WebhooksPanel (project)", () => {
  it("renders the section heading and an add affordance when canWrite", () => {
    const markup = renderToStaticMarkup(
      createElement(WebhooksPanel, { slug: "demo", canWrite: true }),
    );

    expect(markup).toContain("sectionTitle");
    expect(markup).toContain("add");
    expect(markup).toContain("empty");
  });

  it("hides the add affordance when not canWrite (viewer reads only)", () => {
    const markup = renderToStaticMarkup(
      createElement(WebhooksPanel, { slug: "demo", canWrite: false }),
    );

    expect(markup).toContain("sectionTitle");
    expect(markup).not.toContain("add");
  });
});
