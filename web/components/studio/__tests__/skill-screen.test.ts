import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  packageFileKindLabels,
  packageFilesEditorLabels,
} from "@/lib/flows/editor/editor-labels";
import { SkillScreen } from "@/components/studio/skill-screen";

const stubT = Object.assign((key: string) => key, {
  raw: (key: string) => key,
});
const filesLabels = packageFilesEditorLabels(
  stubT as never,
  stubT as never,
  true,
);
const fileKindLabels = packageFileKindLabels(stubT as never);

const labels = {
  crumbStudio: "Studio",
  crumbLocal: "Local",
  crumbSkills: "Skills",
  save: "Save",
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
      filesLabels,
      fileKindLabels,
      mcpCatalog: [],
      onDraftFilesChange: vi.fn(),
      onSave: vi.fn(),
      onRename: vi.fn(),
    } as never),
  );
}

describe("SkillScreen (ADR-115 §P4)", () => {
  it("scopes the navigator to the skill's nested files + breadcrumb back to Skills", () => {
    const html = render("arch");

    expect(html).toContain('data-testid="skill-screen"');
    expect(html).toContain('data-testid="skill-screen-id"');
    expect(html).toContain("arch");
    // Breadcrumb links back to the composition Skills tab.
    expect(html).toContain('href="/studio/edit/pkg1?tab=skills"');
    // The skill's own files are listed; the sibling rule + manifest are NOT.
    expect(html).toContain("SKILL.md");
    expect(html).not.toContain("rules/r1.md");
    expect(html).not.toContain("maister-package.yaml");
    expect(html).toContain('data-testid="skill-screen-save"');
    // The folder rename affordance is present (editable).
    expect(html).toContain('data-testid="skill-screen-rename-open"');
  });

  it("hides Save + Rename when readOnly", () => {
    const html = render("arch", true);

    expect(html).toContain('data-testid="skill-screen"');
    expect(html).not.toContain('data-testid="skill-screen-save"');
    expect(html).not.toContain('data-testid="skill-screen-rename-open"');
  });

  it("shows a not-found state for an unknown skill", () => {
    const html = render("ghost");

    expect(html).toContain('data-testid="skill-screen-not-found"');
    expect(html).toContain("No such skill");
  });
});
