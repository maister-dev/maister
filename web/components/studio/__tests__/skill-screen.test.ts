import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { packageFilesEditorLabels } from "@/lib/flows/editor/editor-labels";

// The navigator needs the app-router context; stub it to echo the props the
// SkillScreen feeds it (scoped-relative paths + the subtree prefix).
vi.mock("@/components/studio/package-file-navigator", () => ({
  PackageFileNavigator: (props: {
    draftFiles: { path: string }[];
    pathPrefix?: string;
  }) =>
    createElement(
      "div",
      { "data-testid": "nav-stub", "data-prefix": props.pathPrefix ?? "" },
      props.draftFiles.map((f) => f.path).join("|"),
    ),
}));

import { SkillScreen } from "@/components/studio/skill-screen";

const stubT = Object.assign((key: string) => key, {
  raw: (key: string) => key,
});
const filesLabels = packageFilesEditorLabels(
  stubT as never,
  stubT as never,
  true,
);

const labels = {
  crumbStudio: "Studio",
  crumbLocal: "Local",
  crumbSkills: "Skills",
  notFound: "No such skill",
  rename: { open: "Rename", confirm: "Save name", cancel: "Cancel" },
};

const draftFiles = [
  { kind: "manifest", path: "maister-package.yaml", content: "x" },
  { kind: "skill", path: "skills/arch/SKILL.md", content: "a" },
  { kind: "asset", path: "skills/arch/references/x.md", content: "r" },
  { kind: "rule", path: "rules/r1.md", content: "rule" },
];

function render(skillId: string, readOnly = false): string {
  return renderToStaticMarkup(
    createElement(SkillScreen, {
      packageId: "pkg1",
      name: "my-pkg",
      skillId,
      draftFiles,
      readOnly,
      labels,
      navigatorLabels: {} as never,
      filesLabels,
      importLabels: {} as never,
      mcpCatalog: [],
      onDraftFilesChange: vi.fn(),
      onSave: vi.fn(),
      onRename: vi.fn(),
    } as never),
  );
}

describe("SkillScreen (ADR-116 §P4)", () => {
  it("feeds the navigator the skill's files RELATIVE to its subtree prefix", () => {
    const html = render("arch");

    expect(html).toContain('data-testid="skill-screen"');
    expect(html).toContain('data-testid="skill-screen-id"');
    expect(html).toContain('href="/studio/edit/pkg1?tab=skills"');
    // The navigator gets paths stripped to the skill root + the prefix to re-add.
    expect(html).toContain('data-prefix="skills/arch"');
    expect(html).toContain('data-testid="nav-stub"');
    expect(html).toMatch(/nav-stub[^>]*>[^<]*SKILL\.md\|references\/x\.md/);
    // The sibling rule + manifest are NOT in the scoped set.
    expect(html).not.toContain("rules/r1.md");
    expect(html).not.toContain("maister-package.yaml");
    // The folder rename affordance is present (editable).
    expect(html).toContain('data-testid="skill-screen-rename-open"');
  });

  it("hides Rename when readOnly", () => {
    const html = render("arch", true);

    expect(html).toContain('data-testid="skill-screen"');
    expect(html).not.toContain('data-testid="skill-screen-rename-open"');
  });

  it("shows a not-found state for an unknown skill", () => {
    const html = render("ghost");

    expect(html).toContain('data-testid="skill-screen-not-found"');
    expect(html).toContain("No such skill");
    expect(html).not.toContain('data-testid="nav-stub"');
  });
});
