import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  // Mirror next-intl's `t` shape: a callable with a `.raw` escape hatch
  // (PackageDetail fetches the showingCount template via `t.raw`).
  useTranslations: () =>
    Object.assign((key: string) => key, { raw: (key: string) => key }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
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
      {
        id: "aif-dev",
        nodeCount: 4,
        gateCount: 2,
        engine: "1.3.0",
        frontmatter: {
          title: "AIF dev",
          summary: "Spec-driven delivery flow.",
          labels: ["aif", "delivery"],
          routeWhen: "feature work",
          links: [{ kind: "docs", title: "Docs", url: "https://example.com" }],
          sources: [{ component: "aif", origin: "repo" }],
        },
        graph: null,
      },
      {
        id: "aif-init",
        nodeCount: 1,
        gateCount: 0,
        engine: null,
        frontmatter: {
          title: null,
          summary: null,
          labels: [],
          routeWhen: null,
          links: [],
          sources: [],
        },
        graph: null,
      },
    ],
    platformAgents: [],
    subagents: [{ id: "sub1", description: "a subagent" }],
    skills: [
      {
        id: "s1",
        fileCount: 3,
        subfolderCount: 1,
        description: "Use when package structure needs a careful plan.",
      },
    ],
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
  it("renders wide flow preview cards + non-empty tabs + a rework action", () => {
    const html = renderToStaticMarkup(
      createElement(PackageDetail, base as never),
    );

    // Flows is the default active tab → wide preview cards render.
    expect(html).toContain('data-testid="flow-preview-card"');
    expect(html).toContain("aif-dev");
    expect(html).toContain("aif-init");
    expect(html).toContain("Spec-driven delivery flow.");
    expect(html).toContain("feature work");
    // The Skills tab is present (non-empty) even though its cards are not active.
    expect(html).toContain('data-testid="package-tab-skills"');
    // The Subagents tab (capability subagents) is present and distinct from Agents.
    expect(html).toContain('data-testid="package-tab-subagents"');
    expect(html).toMatch(/rework|fork/i);
  });

  it("shows the requested tab's members when ?tab=skills", () => {
    const html = renderToStaticMarkup(
      createElement(PackageDetail, { ...base, activeTab: "skills" } as never),
    );

    expect(html).toContain("s1");
    expect(html).toContain("Use when package structure needs a careful plan.");
  });

  it("hides Trust for non-admins", () => {
    const html = renderToStaticMarkup(
      createElement(PackageDetail, base as never),
    );

    expect(html).not.toMatch(/\bTrust\b/);
  });
});
