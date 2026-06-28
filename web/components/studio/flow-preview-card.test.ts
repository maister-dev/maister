import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () =>
    Object.assign((key: string) => key, { raw: (key: string) => key }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { FlowPreviewCard } from "@/components/studio/package-detail";

const flow = {
  id: "aif-dev",
  path: "flows/aif-dev",
  nodeCount: 2,
  gateCount: 0,
  engine: null,
  frontmatter: {
    title: "AIF dev",
    summary: null,
    labels: [],
    routeWhen: null,
    links: [],
    sources: [],
  },
  graph: null,
};

const t = ((key: string) => key) as never;
const graphLabels = {} as never;

describe("FlowPreviewCard", () => {
  it("links the title to href and shows a Studio icon link when studioHref is set", () => {
    const html = renderToStaticMarkup(
      createElement(FlowPreviewCard, {
        flow: flow as never,
        graphLabels,
        href: "/projects/demo/packages/aif-dev",
        studioHref: "/studio/packages/aif/flows/aif-dev",
        t,
      }),
    );

    expect(html).toContain('href="/projects/demo/packages/aif-dev"');
    expect(html).toContain('data-testid="flow-card-open-in-studio"');
    expect(html).toContain('href="/studio/packages/aif/flows/aif-dev"');
  });

  it("omits the Studio icon when no studioHref (e.g. inside Studio, where the title already links there)", () => {
    const html = renderToStaticMarkup(
      createElement(FlowPreviewCard, {
        flow: flow as never,
        graphLabels,
        href: "/studio/packages/aif/flows/aif-dev",
        t,
      }),
    );

    expect(html).toContain('href="/studio/packages/aif/flows/aif-dev"');
    expect(html).not.toContain('data-testid="flow-card-open-in-studio"');
  });
});
