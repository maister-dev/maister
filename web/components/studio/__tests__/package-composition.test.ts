import type { PackageBom } from "@/lib/queries/package-bom";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ search: "" }));

vi.mock("next-intl", () => ({
  useTranslations: () =>
    Object.assign((key: string) => key, { raw: (key: string) => key }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import { PackageComposition } from "@/components/studio/package-composition";

const flow = {
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
};

function bomOf(partial: Partial<PackageBom>): PackageBom {
  return {
    flows: [],
    skills: [],
    subagents: [],
    platformAgents: [],
    mcps: [],
    rules: [],
    ...partial,
  };
}

function render(
  bom: PackageBom,
  opts: { search?: string; readOnly?: boolean } = {},
): string {
  nav.search = opts.search ?? "";

  return renderToStaticMarkup(
    createElement(PackageComposition, {
      packageId: "pkg1",
      name: "my-pkg",
      bom,
      fileCount: 3,
      readOnly: opts.readOnly ?? false,
      filesEditor: createElement("div", {
        "data-testid": "files-slot-content",
      }),
    } as never),
  );
}

describe("PackageComposition (ADR-115 §P2)", () => {
  it("renders tab counts and hides empty kind tabs; Files is always present", () => {
    const html = render(bomOf({ flows: [flow] }));

    expect(html).toContain('data-testid="package-tab-flows"');
    expect(html).toContain('data-testid="package-tab-files"');
    // Skills/rules/etc are empty → no tab.
    expect(html).not.toContain('data-testid="package-tab-skills"');
    expect(html).not.toContain('data-testid="package-tab-rules"');
    // Default active tab is the first non-empty kind → flows preview card.
    expect(html).toContain('data-testid="flow-preview-card"');
  });

  it("routes a flow card to the canvas manifest path", () => {
    const html = render(bomOf({ flows: [flow] }));

    expect(html).toContain('href="/studio/edit/pkg1/flows/dev/flow.yaml"');
  });

  it("routes a skill card to its dedicated screen", () => {
    const bom = bomOf({
      skills: [
        {
          id: "arch",
          path: "skills/arch",
          fileCount: 1,
          subfolderCount: 0,
          description: "Arch skill",
        },
      ],
    });
    const html = render(bom, { search: "tab=skills" });

    expect(html).toContain('href="/studio/edit/pkg1/skills/arch"');
    expect(html).toContain("Arch skill");
  });

  it("renders inline kinds as master-detail with ?sel links + select hint", () => {
    const bom = bomOf({ rules: [{ id: "r1.md", path: "rules/r1.md" }] });
    const html = render(bom, { search: "tab=rules" });

    expect(html).toContain('data-testid="composition-master-detail"');
    expect(html).toContain('href="/studio/edit/pkg1?tab=rules&amp;sel=r1.md"');
    expect(html).toContain("composition.selectHint");
  });

  it("shows the selected inline item summary when ?sel is set", () => {
    const bom = bomOf({
      subagents: [
        {
          id: "sub1",
          path: "capability/c/agents/sub1.md",
          description: "A sub",
        },
      ],
    });
    const html = render(bom, { search: "tab=subagents&sel=sub1" });

    expect(html).toContain('data-testid="composition-inline-summary"');
    expect(html).toContain("A sub");
  });

  it("hosts the files editor slot on the Files tab and reflects readOnly", () => {
    const html = render(bomOf({}), { search: "tab=files", readOnly: true });

    expect(html).toContain('data-testid="files-slot-content"');
    expect(html).toContain('data-testid="composition-files"');
    expect(html).toContain('data-readonly="true"');
  });

  it("falls back to the Files tab for an empty package", () => {
    const html = render(bomOf({}));

    expect(html).toContain('data-testid="package-tab-files"');
    expect(html).toContain('data-testid="files-slot-content"');
  });
});
