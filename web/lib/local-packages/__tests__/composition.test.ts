import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";
import type { PackageBom } from "@/lib/queries/package-bom";

import { describe, expect, it } from "vitest";

import {
  compositionCounts,
  compositionTabHref,
  flowCanvasHref,
  folderPathsOf,
  inlineSelectHref,
  isInlineKind,
  isMcpDescriptorPath,
  listCapabilities,
  mergeSkillFiles,
  movePathInDraft,
  resolveCompositionTab,
  resolveInlineFilePath,
  scopeSkillFiles,
  skillScreenHref,
  skillSubtreePrefix,
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

describe("listCapabilities (ADR-115 §P5)", () => {
  it("returns the distinct sorted capability bundles in the draft", () => {
    const files: AuthoredFlowPackageFile[] = [
      { kind: "subagent", path: "capability/core/agents/a.md", content: "" },
      { kind: "subagent", path: "capability/aux/agents/b.md", content: "" },
      { kind: "asset", path: "capability/core/skills/s/SKILL.md", content: "" },
      { kind: "rule", path: "rules/r.md", content: "" },
    ];

    expect(listCapabilities(files)).toEqual(["aux", "core"]);
    expect(listCapabilities([])).toEqual([]);
  });
});

describe("movePathInDraft + folderPathsOf (ADR-115 §P7, D7)", () => {
  const files: AuthoredFlowPackageFile[] = [
    { kind: "rule", path: "rules/r1.md", content: "a" },
    { kind: "asset", path: "assets/logo.png", content: "" },
    { kind: "skill", path: "skills/arch/SKILL.md", content: "s" },
    { kind: "asset", path: "skills/arch/references/x.md", content: "r" },
  ];

  it("lists every implied folder, deduped + sorted", () => {
    expect(folderPathsOf(files)).toEqual([
      "assets",
      "rules",
      "skills",
      "skills/arch",
      "skills/arch/references",
    ]);
  });

  it("moves a file into a target folder (rewrites path, reclassifies)", () => {
    const res = movePathInDraft(files, "assets/logo.png", "skills/arch");

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.files.some((f) => f.path === "skills/arch/logo.png")).toBe(true);
    expect(res.files.some((f) => f.path === "assets/logo.png")).toBe(false);
  });

  it("moves a file to root", () => {
    const res = movePathInDraft(files, "rules/r1.md", "");

    expect(res.ok && res.files.some((f) => f.path === "r1.md")).toBe(true);
  });

  it("moves a whole folder (all children) by prefix rewrite", () => {
    const res = movePathInDraft(files, "skills/arch", "vendor");

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(
      res.files.filter((f) => f.path.startsWith("vendor/arch/")),
    ).toHaveLength(2);
    expect(res.files.some((f) => f.path.startsWith("skills/arch/"))).toBe(
      false,
    );
  });

  it("rejects a destination collision with CONFLICT", () => {
    const res = movePathInDraft(
      [
        { kind: "rule", path: "rules/a.md", content: "" },
        { kind: "rule", path: "dst/a.md", content: "" },
      ],
      "rules/a.md",
      "dst",
    );

    expect(res).toEqual({ ok: false, code: "CONFLICT" });
  });

  it("rejects moving a folder into its own subtree with PRECONDITION", () => {
    const res = movePathInDraft(files, "skills/arch", "skills/arch/references");

    expect(res).toEqual({ ok: false, code: "PRECONDITION" });
  });
});

describe("skill subtree scope/merge (ADR-115 §P4)", () => {
  const files: AuthoredFlowPackageFile[] = [
    { kind: "manifest", path: "maister-package.yaml", content: "x" },
    { kind: "skill", path: "skills/arch/SKILL.md", content: "a" },
    { kind: "asset", path: "skills/arch/references/x.md", content: "r" },
    { kind: "skill", path: "skills/other/SKILL.md", content: "o" },
    { kind: "rule", path: "rules/r1.md", content: "rule" },
  ];

  it("prefix + scope select only the skill's nested files", () => {
    expect(skillSubtreePrefix("arch")).toBe("skills/arch/");
    expect(scopeSkillFiles(files, "arch").map((f) => f.path)).toEqual([
      "skills/arch/SKILL.md",
      "skills/arch/references/x.md",
    ]);
  });

  it("merge replaces the skill's subtree and preserves everything else", () => {
    const edited: AuthoredFlowPackageFile[] = [
      { kind: "skill", path: "skills/arch/SKILL.md", content: "EDITED" },
    ];
    const merged = mergeSkillFiles(files, "arch", edited);

    expect(merged.map((f) => f.path)).toEqual([
      "maister-package.yaml",
      "skills/other/SKILL.md",
      "rules/r1.md",
      "skills/arch/SKILL.md",
    ]);
    expect(merged.find((f) => f.path === "skills/arch/SKILL.md")?.content).toBe(
      "EDITED",
    );
    // The dropped reference file is gone; sibling skill + rule untouched.
    expect(merged.some((f) => f.path === "skills/arch/references/x.md")).toBe(
      false,
    );
  });
});
