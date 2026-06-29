import type { PackageBom } from "@/lib/queries/package-bom";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { packageFilesEditorLabels } from "@/lib/flows/editor/editor-labels";

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

const stubT = Object.assign((key: string) => key, {
  raw: (key: string) => key,
});
const filesLabels = packageFilesEditorLabels(
  stubT as never,
  stubT as never,
  true,
);
const mcpCatalog = [
  {
    id: "github",
    transport: "stdio",
    command: "x",
    args: [],
    url: null,
    envKeys: [],
    headerKeys: [],
  },
];

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
  opts: {
    search?: string;
    readOnly?: boolean;
    draftFiles?: Array<{ kind: string; path: string; content: string }>;
  } = {},
): string {
  nav.search = opts.search ?? "";

  return renderToStaticMarkup(
    createElement(PackageComposition, {
      packageId: "pkg1",
      name: "my-pkg",
      bom,
      fileCount: 3,
      readOnly: opts.readOnly ?? false,
      draftFiles: opts.draftFiles ?? [],
      filesLabels,
      mcpCatalog,
      saveLabel: "Save",
      filesEditor: createElement("div", {
        "data-testid": "files-slot-content",
      }),
      onDraftFilesChange: vi.fn(),
      onSaveDraft: vi.fn(),
    } as never),
  );
}

describe("PackageComposition (ADR-116 §P2/P3)", () => {
  it("renders tab counts and hides empty kind tabs; Files is always present", () => {
    const html = render(bomOf({ flows: [flow] }));

    expect(html).toContain('data-testid="package-tab-flows"');
    expect(html).toContain('data-testid="package-tab-files"');
    expect(html).not.toContain('data-testid="package-tab-skills"');
    expect(html).not.toContain('data-testid="package-tab-rules"');
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
    // Local composition cards are whole-card clickable with no fork stub and no
    // separate View button (ADR-116 follow-up).
    expect(html).not.toContain('data-testid="element-card-fork"');
    expect(html).not.toContain('data-testid="element-card-view"');
  });

  it("makes inline-kind cards whole-card clickable, no fork/View", () => {
    const bom = bomOf({
      subagents: [
        { id: "helper", path: "capability/c/agents/helper.md", description: "" },
      ],
    });
    const html = render(bom, { search: "tab=subagents" });

    // The card itself is the link (anchor carrying the ?sel href).
    expect(html).toMatch(
      /<a[^>]+data-testid="element-card"[^>]+href="\/studio\/edit\/pkg1\?tab=subagents&amp;sel=helper"/,
    );
    expect(html).not.toContain('data-testid="element-card-fork"');
    expect(html).not.toContain('data-testid="element-card-view"');
  });

  it("renders inline kinds as master-detail with ?sel links + select hint", () => {
    const bom = bomOf({ rules: [{ id: "r1.md", path: "rules/r1.md" }] });
    const html = render(bom, { search: "tab=rules" });

    expect(html).toContain('data-testid="composition-master-detail"');
    expect(html).toContain('href="/studio/edit/pkg1?tab=rules&amp;sel=r1.md"');
    expect(html).toContain("composition.selectHint");
  });

  it("mounts the frontmatter editor + Save for a selected rule", () => {
    const bom = bomOf({ rules: [{ id: "r1.md", path: "rules/r1.md" }] });
    const html = render(bom, {
      search: "tab=rules&sel=r1.md",
      draftFiles: [{ kind: "rule", path: "rules/r1.md", content: "x" }],
    });

    expect(html).toContain('data-testid="composition-inline-editor"');
    expect(html).toContain("rules/r1.md");
    expect(html).toContain('data-testid="composition-inline-save"');
  });

  it("hides the inline Save button when readOnly", () => {
    const bom = bomOf({ rules: [{ id: "r1.md", path: "rules/r1.md" }] });
    const html = render(bom, {
      search: "tab=rules&sel=r1.md",
      readOnly: true,
      draftFiles: [{ kind: "rule", path: "rules/r1.md", content: "x" }],
    });

    expect(html).toContain('data-testid="composition-inline-editor"');
    expect(html).not.toContain('data-testid="composition-inline-save"');
  });

  it("routes a selected MCP to the McpTemplateEditor", () => {
    const bom = bomOf({ mcps: [{ id: "github" }] });
    const html = render(bom, {
      search: "tab=mcps&sel=github",
      draftFiles: [
        { kind: "asset", path: "mcps/github.yaml", content: "id: github" },
      ],
    });

    expect(html).toContain('data-testid="composition-inline-editor"');
    expect(html).toContain('data-testid="mcp-template-catalog"');
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
