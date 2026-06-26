import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";

import { describe, expect, it } from "vitest";

import { buildPackageCapabilityCatalog } from "@/lib/capabilities/package-catalog";

const files: AuthoredFlowPackageFile[] = [
  { kind: "skill", path: "skills/review/SKILL.md", content: "# review" },
  { kind: "skill", path: "skills/aif-plan/SKILL.md", content: "# plan" },
  // non-SKILL.md skill assets are ignored
  { kind: "asset", path: "skills/aif-plan/references/x.md", content: "x" },
  // non-skill files are ignored
  { kind: "manifest", path: "maister-package.yaml", content: "name: p" },
];

describe("buildPackageCapabilityCatalog", () => {
  it("derives one entry per skills/<slug>/SKILL.md, sorted by name", () => {
    const catalog = buildPackageCapabilityCatalog(files, "claude");

    expect(catalog.map((entry) => entry.slug)).toEqual(["aif-plan", "review"]);

    const plan = catalog.find((entry) => entry.slug === "aif-plan");

    expect(plan).toMatchObject({
      kind: "skill",
      refId: "aif-plan",
      displayName: "aif-plan",
      canonicalToken: "@skill:aif-plan",
      surfaceForm: "/aif-plan",
      supported: true,
    });
  });

  it("renders the per-adapter surface form (codex sigil)", () => {
    const catalog = buildPackageCapabilityCatalog(files, "codex");

    expect(catalog.find((entry) => entry.slug === "review")?.surfaceForm).toBe(
      "$review",
    );
  });

  it("returns an empty catalog when there are no skills", () => {
    expect(
      buildPackageCapabilityCatalog(
        [{ kind: "manifest", path: "maister-package.yaml", content: "" }],
        "claude",
      ),
    ).toEqual([]);
  });
});
