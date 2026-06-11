import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Mirrors mcp-servers-panel.test.ts: identity-key i18n + stubbed navigation, so
// the client panel renders to static markup. useEffect (the list/settings fetch)
// does not fire under server rendering, so the panel renders its initial state.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/settings",
}));

import { WebhooksPanel } from "@/components/settings/webhooks-panel";

describe("settings WebhooksPanel (platform)", () => {
  it("renders the section heading and an add affordance (admin canWrite)", () => {
    const markup = renderToStaticMarkup(createElement(WebhooksPanel));

    expect(markup).toContain("sectionTitle");
    expect(markup).toContain("add");
  });

  it("renders the empty subscriptions state (no rows before fetch)", () => {
    const markup = renderToStaticMarkup(createElement(WebhooksPanel));

    // The T13 table's empty key — the platform panel always starts empty since
    // the effect-driven fetch does not run during static rendering.
    expect(markup).toContain("empty");
  });
});
