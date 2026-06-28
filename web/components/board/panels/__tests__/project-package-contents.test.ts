import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals && "count" in vals ? `${vals.count} ${key}` : key,
}));
vi.mock("@/components/studio/package-detail", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/studio/package-detail")>();

  return {
    ...actual,
    FlowPreviewCard: ({
      href,
      studioHref,
    }: {
      href: string;
      studioHref?: string;
    }) =>
      createElement(
        "a",
        { "data-testid": "flow-card", "data-studio-href": studioHref, href },
        "flow",
      ),
  };
});

import { ProjectPackageContents } from "@/components/board/panels/project-package-contents";

describe("ProjectPackageContents", () => {
  it("renders a per-package block with a Studio link, flow cards, and a count line", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectPackageContents, {
        slug: "demo",
        contents: [
          {
            packageName: "aif",
            versionLabel: "aif/v1.0.0",
            flows: [
              {
                id: "dev",
                path: "flows/dev",
                nodeCount: 2,
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
            counts: { skills: 3, agents: 2, subagents: 0, mcps: 1, rules: 0 },
          },
        ],
      }),
    );

    expect(markup).toContain("contentsTitle");
    expect(markup).toContain("/studio/packages/aif");
    expect(markup).toContain("/projects/demo/packages/dev");
    // Each flow card also carries the Studio flow URL (right-aligned icon link).
    expect(markup).toContain(
      'data-studio-href="/studio/packages/aif/flows/dev"',
    );
    // Non-zero kinds only, joined " · ".
    expect(markup).toContain("3 countSkills");
    expect(markup).toContain("2 countAgents");
    expect(markup).toContain("1 countMcps");
    expect(markup).not.toContain("countSubagents");
    expect(markup).not.toContain("countRules");
  });

  it("renders nothing when there is no package content", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectPackageContents, { slug: "demo", contents: [] }),
    );

    expect(markup).toBe("");
  });
});
