import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";

import { describe, expect, it } from "vitest";

import { renameArtifact } from "@/lib/local-packages/rename-artifact";

function paths(files: AuthoredFlowPackageFile[]): string[] {
  return files.map((f) => f.path).sort();
}

describe("renameArtifact (ADR-116 P6, D8)", () => {
  it("single-file kinds rename one path; frontmatter untouched", () => {
    const draftFiles: AuthoredFlowPackageFile[] = [
      {
        kind: "rule",
        path: "rules/old.md",
        content: "---\nname: old\n---\nbody",
      },
    ];
    const res = renameArtifact({
      kind: "rules",
      id: "old.md",
      path: "rules/old.md",
      newName: "new",
      packageId: "pkg1",
      draftFiles,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(paths(res.files)).toEqual(["rules/new.md"]);
    // The frontmatter/body content is carried verbatim — rename ≠ metadata edit.
    expect(res.files[0].content).toBe("---\nname: old\n---\nbody");
    expect(res.navigate).toBe("/studio/edit/pkg1?tab=rules&sel=new.md");
  });

  it("subagent/agent/mcp keep their dir + extension", () => {
    const sub = renameArtifact({
      kind: "subagents",
      id: "old",
      path: "capability/core/agents/old.md",
      newName: "fresh",
      packageId: "pkg1",
      draftFiles: [
        {
          kind: "subagent",
          path: "capability/core/agents/old.md",
          content: "x",
        },
      ],
    });
    const mcp = renameArtifact({
      kind: "mcps",
      id: "old",
      path: "mcps/old.yaml",
      newName: "fresh",
      packageId: "pkg1",
      draftFiles: [{ kind: "asset", path: "mcps/old.yaml", content: "x" }],
    });

    expect(sub.ok && sub.files[0].path).toBe("capability/core/agents/fresh.md");
    expect(mcp.ok && mcp.files[0].path).toBe("mcps/fresh.yaml");
  });

  it("skill folder rename moves every child", () => {
    const draftFiles: AuthoredFlowPackageFile[] = [
      { kind: "skill", path: "skills/old/SKILL.md", content: "s" },
      { kind: "asset", path: "skills/old/references/a.md", content: "r" },
      { kind: "rule", path: "rules/keep.md", content: "k" },
    ];
    const res = renameArtifact({
      kind: "skills",
      id: "old",
      path: "skills/old",
      newName: "new",
      packageId: "pkg1",
      draftFiles,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(paths(res.files)).toEqual([
      "rules/keep.md",
      "skills/new/SKILL.md",
      "skills/new/references/a.md",
    ]);
    expect(res.navigate).toBe("/studio/edit/pkg1/skills/new");
  });

  it("renames a capability-nested skill at its real prefix", () => {
    const draftFiles: AuthoredFlowPackageFile[] = [
      {
        kind: "skill",
        path: "capability/core/skills/aif/SKILL.md",
        content: "s",
      },
      {
        kind: "asset",
        path: "capability/core/skills/aif/references/a.md",
        content: "r",
      },
      { kind: "rule", path: "rules/keep.md", content: "k" },
    ];
    const res = renameArtifact({
      kind: "skills",
      id: "aif",
      path: "skills/aif",
      newName: "aif2",
      packageId: "pkg1",
      draftFiles,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(paths(res.files)).toEqual([
      "capability/core/skills/aif2/SKILL.md",
      "capability/core/skills/aif2/references/a.md",
      "rules/keep.md",
    ]);
    expect(res.navigate).toBe("/studio/edit/pkg1/skills/aif2");
  });

  it("flow rename moves the dir AND updates the manifest id+path", () => {
    const draftFiles: AuthoredFlowPackageFile[] = [
      {
        kind: "manifest",
        path: "maister-package.yaml",
        content: [
          "schemaVersion: 1",
          "name: pkg",
          "flows:",
          "  - id: old",
          "    path: flows/old",
          "",
        ].join("\n"),
      },
      { kind: "asset", path: "flows/old/flow.yaml", content: "name: old" },
    ];
    const res = renameArtifact({
      kind: "flows",
      id: "old",
      path: "flows/old",
      newName: "new",
      packageId: "pkg1",
      draftFiles,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.files.some((f) => f.path === "flows/new/flow.yaml")).toBe(true);
    const manifest =
      res.files.find((f) => f.path === "maister-package.yaml")?.content ?? "";

    expect(manifest).toContain("id: new");
    expect(manifest).toContain("path: flows/new");
    expect(manifest).not.toContain("id: old");
    expect(res.navigate).toBe("/studio/edit/pkg1/flows/new/flow.yaml");
  });

  it("flow rename syncs flow.yaml name to the manifest id (installer invariant; Codex high)", () => {
    const draftFiles: AuthoredFlowPackageFile[] = [
      {
        kind: "manifest",
        path: "maister-package.yaml",
        content: [
          "schemaVersion: 1",
          "name: pkg",
          "flows:",
          "  - id: old",
          "    path: flows/old",
          "",
        ].join("\n"),
      },
      {
        kind: "asset",
        path: "flows/old/flow.yaml",
        content: [
          "schemaVersion: 1",
          "name: old",
          "steps:",
          "  - id: s",
          "    type: agent",
          "    mode: new-session",
          "    prompt: go",
          "",
        ].join("\n"),
      },
    ];
    const res = renameArtifact({
      kind: "flows",
      id: "old",
      path: "flows/old",
      newName: "new",
      packageId: "pkg1",
      draftFiles,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const flowYaml =
      res.files.find((f) => f.path === "flows/new/flow.yaml")?.content ?? "";
    const manifest =
      res.files.find((f) => f.path === "maister-package.yaml")?.content ?? "";

    // The installer rejects flow.yaml name !== manifest flow id — both must move.
    expect(flowYaml).toContain("name: new");
    expect(flowYaml).not.toContain("name: old");
    expect(manifest).toContain("id: new");
    // The rest of the flow.yaml (steps) is preserved — only `name` changes.
    expect(flowYaml).toContain("id: s");
  });

  it("flow rename fails CONFIG when the moved flow.yaml is unparseable", () => {
    const draftFiles: AuthoredFlowPackageFile[] = [
      {
        kind: "manifest",
        path: "maister-package.yaml",
        content: [
          "schemaVersion: 1",
          "name: pkg",
          "flows:",
          "  - id: old",
          "    path: flows/old",
          "",
        ].join("\n"),
      },
      { kind: "asset", path: "flows/old/flow.yaml", content: "name: [bad" },
    ];
    const res = renameArtifact({
      kind: "flows",
      id: "old",
      path: "flows/old",
      newName: "new",
      packageId: "pkg1",
      draftFiles,
    });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.code).toBe("CONFIG");
  });

  it("rejects a collision with CONFLICT (single-file + folder)", () => {
    const single = renameArtifact({
      kind: "rules",
      id: "a.md",
      path: "rules/a.md",
      newName: "b",
      packageId: "pkg1",
      draftFiles: [
        { kind: "rule", path: "rules/a.md", content: "a" },
        { kind: "rule", path: "rules/b.md", content: "b" },
      ],
    });
    const folder = renameArtifact({
      kind: "skills",
      id: "a",
      path: "skills/a",
      newName: "b",
      packageId: "pkg1",
      draftFiles: [
        { kind: "skill", path: "skills/a/SKILL.md", content: "a" },
        { kind: "skill", path: "skills/b/SKILL.md", content: "b" },
      ],
    });

    expect(single.ok).toBe(false);
    expect(!single.ok && single.code).toBe("CONFLICT");
    expect(folder.ok).toBe(false);
    expect(!folder.ok && folder.code).toBe("CONFLICT");
  });

  it("rejects an invalid name with PRECONDITION", () => {
    const res = renameArtifact({
      kind: "rules",
      id: "a.md",
      path: "rules/a.md",
      newName: "../x",
      packageId: "pkg1",
      draftFiles: [{ kind: "rule", path: "rules/a.md", content: "a" }],
    });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.code).toBe("PRECONDITION");
  });
});
