import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// renderToStaticMarkup drives the INITIAL render only (no clicks). The confirm
// dialog + persist round-trip are behind state → covered by the T26 e2e. Here
// we assert the static nudge: shown for needsPersist+canEdit, empty otherwise.
vi.mock("next-intl", () => ({
  useTranslations:
    (ns: string) =>
    (key: string, vals?: Record<string, unknown>): string =>
      vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
  ConfigPersistBanner,
  type ConfigPersistBannerProps,
} from "@/components/projects/config-persist-banner";

function render(over: Partial<ConfigPersistBannerProps> = {}): string {
  const props: ConfigPersistBannerProps = {
    slug: "demo",
    projectName: "Demo",
    needsPersist: true,
    canEdit: true,
    settingsHref: "/projects/demo?tab=settings",
    ...over,
  };

  return renderToStaticMarkup(createElement(ConfigPersistBanner, props));
}

describe("ConfigPersistBanner", () => {
  it("renders the persist CTA, dismiss, and settings link when needsPersist and canEdit", () => {
    const html = render();

    expect(html).toContain("projects.persistBanner.persist");
    expect(html).toContain("projects.persistBanner.dismiss");
    expect(html).toContain("projects.persistBanner.settingsLink");
    expect(html).toContain("/projects/demo?tab=settings");
  });

  it("renders nothing when the config is already persisted (needsPersist false)", () => {
    expect(render({ needsPersist: false })).toBe("");
  });

  it("renders nothing when the viewer cannot editSettings (never a 403 CTA)", () => {
    expect(render({ canEdit: false })).toBe("");
  });
});
