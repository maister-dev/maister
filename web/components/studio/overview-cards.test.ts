import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () =>
    (key: string, values?: Record<string, string>) =>
      values ? `${key}:${Object.values(values).join(":")}` : key,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { OverviewCards } from "@/components/studio/overview-cards";

const groups = [
  {
    key: "a",
    name: "aif",
    sourceUrl: "file:///x",
    isLocal: true,
    needsTrust: false,
    counts: {
      flows: 5,
      skills: 2,
      platformAgents: 0,
      subagents: 0,
      mcps: 0,
      rules: 0,
    },
    versions: [
      {
        installId: "i",
        versionLabel: "local-dev",
        trustStatus: "trusted_by_policy",
      },
    ],
    attachedProjectCount: 1,
  },
  {
    key: "b",
    name: "bugfix",
    sourceUrl: "github.com/x",
    isLocal: false,
    needsTrust: true,
    counts: {
      flows: 1,
      skills: 0,
      platformAgents: 0,
      subagents: 0,
      mcps: 0,
      rules: 0,
    },
    versions: [
      { installId: "j", versionLabel: "v0.0.1", trustStatus: "untrusted" },
    ],
    attachedProjectCount: 0,
  },
];

describe("OverviewCards", () => {
  it("shows counts and a needs-attention entry for untrusted packages", () => {
    const html = renderToStaticMarkup(
      createElement(OverviewCards, {
        groups: groups as never,
        isAdmin: true,
        localSummary: {
          activeCount: 3,
          cutCount: 1,
          totalCount: 4,
          uncutCount: 2,
        },
        sourceSummary: {
          sourceCount: 2,
          enabledSourceCount: 1,
          discoveredPackageCount: 5,
          discoveredTagCount: 8,
        },
        recentLocalPackages: [],
      }),
    );

    expect(html).toContain("overviewInstalledMetric");
    expect(html).toContain("overviewAvailableMetric");
    expect(html).toContain("overviewActiveMetric");
    expect(html).toContain("attentionTrustTitle");
    expect(html).toContain("attentionLocalTitle");
    expect(html).toContain("/studio/packages");
    expect(html).toContain("/studio/local");
    expect(html).toContain("/studio/sources");
  });

  it("hides the Sources card for non-admins", () => {
    const html = renderToStaticMarkup(
      createElement(OverviewCards, {
        groups: [] as never,
        isAdmin: false,
        localSummary: {
          activeCount: 0,
          cutCount: 0,
          totalCount: 0,
          uncutCount: 0,
        },
        recentLocalPackages: [],
        sourceSummary: null,
      }),
    );

    expect(html).not.toContain("/studio/sources");
  });

  it("shows recent local packages as clickable rows with cut icon actions", () => {
    const html = renderToStaticMarkup(
      createElement(OverviewCards, {
        groups: [] as never,
        isAdmin: false,
        localSummary: {
          activeCount: 2,
          cutCount: 1,
          totalCount: 2,
          uncutCount: 1,
        },
        sourceSummary: null,
        recentLocalPackages: [
          {
            id: "lp-1",
            name: "openspec-local",
            slug: "openspec-local",
            status: "active",
            isDefault: false,
            origin: {
              kind: "forked",
              packageName: "openspec",
              versionLabel: "v1.2.3",
            },
            lastCutInstallId: null,
            updatedAt: "2026-06-27T10:00:00.000Z",
          },
        ],
      }),
    );

    expect(html).toContain("continueWorkTitle");
    expect(html).toContain("openspec-local");
    expect(html).toContain("local.originForked:openspec:v1.2.3");
    expect(html).toContain("/studio/edit/lp-1");
    expect(html).toContain('aria-label="continueWorkCut"');
    expect(html).not.toContain("continueWorkOpen");
    expect(html).not.toContain("continueWorkImport");
  });
});
