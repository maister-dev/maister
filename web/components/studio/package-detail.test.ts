import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { PackageDetail } from "@/components/studio/package-detail";

const pkg = {
  name: "aif",
  sourceUrl: "file:///x",
  isLocal: true,
  versions: [
    {
      installId: "i",
      versionLabel: "local-dev",
      trustStatus: "trusted_by_policy",
    },
  ],
  bom: {
    flows: [
      { id: "aif-dev", nodeCount: 4, gateCount: 2, engine: "1.3.0" },
      { id: "aif-init", nodeCount: 1, gateCount: 0, engine: null },
    ],
    agents: [],
    skills: [{ id: "s1", fileCount: 3, subfolderCount: 1 }],
    mcps: [],
    rules: [],
  },
};

const base = {
  pkg: pkg as never,
  canManage: true,
  canTrust: false,
  basePath: "/studio/packages/aif",
  activeTab: "flows",
  page: 1,
};

describe("PackageDetail", () => {
  it("renders the active-tab cards + non-empty tabs + a rework action", () => {
    const html = renderToStaticMarkup(
      createElement(PackageDetail, base as never),
    );

    // Flows is the default active tab → its cards render (no bare id chips).
    expect(html).toContain('data-testid="element-card"');
    expect(html).toContain("aif-dev");
    expect(html).toContain("aif-init");
    // The Skills tab is present (non-empty) even though its cards are not active.
    expect(html).toContain('data-testid="package-tab-skills"');
    expect(html).toMatch(/rework|fork/i);
  });

  it("shows the requested tab's members when ?tab=skills", () => {
    const html = renderToStaticMarkup(
      createElement(PackageDetail, { ...base, activeTab: "skills" } as never),
    );

    expect(html).toContain("s1");
  });

  it("hides Trust for non-admins", () => {
    const html = renderToStaticMarkup(
      createElement(PackageDetail, base as never),
    );

    expect(html).not.toMatch(/\bTrust\b/);
  });
});
