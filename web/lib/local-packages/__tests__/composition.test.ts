import type { PackageBom } from "@/lib/queries/package-bom";

import { describe, expect, it } from "vitest";

import {
  compositionCounts,
  compositionTabHref,
  flowCanvasHref,
  inlineSelectHref,
  isInlineKind,
  isMcpDescriptorPath,
  resolveCompositionTab,
  resolveInlineFilePath,
  skillScreenHref,
  visibleCompositionTabs,
} from "@/lib/local-packages/composition";

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

const flow = {
  id: "dev",
  path: "flows/dev",
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
};

describe("composition tab logic (ADR-115 §P2)", () => {
  it("counts equal BOM array lengths", () => {
    const bom = bomOf({
      flows: [flow],
      skills: [
        {
          id: "s1",
          path: "skills/s1",
          fileCount: 1,
          subfolderCount: 0,
          description: "",
        },
      ],
      rules: [{ id: "r1.md", path: "rules/r1.md" }],
    });

    expect(compositionCounts(bom)).toEqual({
      flows: 1,
      skills: 1,
      subagents: 0,
      agents: 0,
      mcps: 0,
      rules: 1,
    });
  });

  it("hides empty kind tabs; Files is always shown", () => {
    const bom = bomOf({ flows: [flow] });

    expect(visibleCompositionTabs(bom)).toEqual(["flows", "files"]);
  });

  it("Files is the only tab for an empty package", () => {
    expect(visibleCompositionTabs(bomOf({}))).toEqual(["files"]);
  });

  it("resolves the requested tab when visible, else the first visible kind", () => {
    const bom = bomOf({
      flows: [flow],
      rules: [{ id: "r1.md", path: "rules/r1.md" }],
    });

    expect(resolveCompositionTab("rules", bom)).toBe("rules");
    // skills is empty → not visible → fall back to first visible kind (flows)
    expect(resolveCompositionTab("skills", bom)).toBe("flows");
    expect(resolveCompositionTab(null, bom)).toBe("flows");
    // empty package → files
    expect(resolveCompositionTab("flows", bomOf({}))).toBe("files");
  });

  it("classifies inline kinds", () => {
    expect(isInlineKind("subagents")).toBe(true);
    expect(isInlineKind("agents")).toBe(true);
    expect(isInlineKind("mcps")).toBe(true);
    expect(isInlineKind("rules")).toBe(true);
    expect(isInlineKind("flows")).toBe(false);
    expect(isInlineKind("skills")).toBe(false);
    expect(isInlineKind("files")).toBe(false);
  });
});

describe("composition href builders (ADR-115 §P2 routing targets)", () => {
  it("flow → canvas manifest path (appends flow.yaml to a dir)", () => {
    expect(flowCanvasHref("pkg1", "flows/dev")).toBe(
      "/studio/edit/pkg1/flows/dev/flow.yaml",
    );
    // already a yaml file → used verbatim
    expect(flowCanvasHref("pkg1", "flows/dev.yaml")).toBe(
      "/studio/edit/pkg1/flows/dev.yaml",
    );
  });

  it("skill → dedicated screen route (encoded)", () => {
    expect(skillScreenHref("pkg1", "arch")).toBe(
      "/studio/edit/pkg1/skills/arch",
    );
  });

  it("inline kind → ?tab&sel query on the landing", () => {
    expect(inlineSelectHref("pkg1", "rules", "r1.md")).toBe(
      "/studio/edit/pkg1?tab=rules&sel=r1.md",
    );
    expect(inlineSelectHref("pkg1", "subagents", "a b")).toBe(
      "/studio/edit/pkg1?tab=subagents&sel=a%20b",
    );
  });

  it("tab link → ?tab on the landing", () => {
    expect(compositionTabHref("pkg1", "skills")).toBe(
      "/studio/edit/pkg1?tab=skills",
    );
  });
});

describe("isMcpDescriptorPath (ADR-115 §D6)", () => {
  it("matches a direct mcps/*.yaml|yml child only", () => {
    expect(isMcpDescriptorPath("mcps/github.yaml")).toBe(true);
    expect(isMcpDescriptorPath("mcps/github.yml")).toBe(true);
    expect(isMcpDescriptorPath("mcps/nested/x.yaml")).toBe(false);
    expect(isMcpDescriptorPath("mcps/readme.md")).toBe(false);
  });
});

describe("resolveInlineFilePath (ADR-115 §P3)", () => {
  const bom = bomOf({
    subagents: [
      { id: "sub1", path: "capability/c/agents/sub1.md", description: "" },
    ],
    platformAgents: [
      {
        id: "p1",
        path: "maister-agents/p1.md",
        description: "",
        triggers: [],
        riskTier: "",
        workspace: "",
      },
    ],
    rules: [{ id: "r1.md", path: "rules/r1.md" }],
    mcps: [{ id: "github" }],
  });

  it("resolves single-file kinds from the BOM card path", () => {
    expect(resolveInlineFilePath("subagents", "sub1", bom, [])).toBe(
      "capability/c/agents/sub1.md",
    );
    expect(resolveInlineFilePath("agents", "p1", bom, [])).toBe(
      "maister-agents/p1.md",
    );
    expect(resolveInlineFilePath("rules", "r1.md", bom, [])).toBe(
      "rules/r1.md",
    );
  });

  it("resolves an MCP id to its mcps/*.yaml file (draft, else canonical)", () => {
    expect(
      resolveInlineFilePath("mcps", "github", bom, [
        { kind: "asset", path: "mcps/github.yml", content: "" },
      ]),
    ).toBe("mcps/github.yml");
    // No draft file → canonical path.
    expect(resolveInlineFilePath("mcps", "github", bom, [])).toBe(
      "mcps/github.yaml",
    );
  });

  it("returns null for an unknown id", () => {
    expect(resolveInlineFilePath("rules", "ghost.md", bom, [])).toBeNull();
  });
});
