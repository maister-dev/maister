import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";

import { describe, expect, it } from "vitest";

import {
  buildFileTree,
  classifyPackageFilePath,
  validatePathEdit,
} from "@/lib/flows/editor/package-file-tree";

function file(path: string): AuthoredFlowPackageFile {
  return { kind: classifyPackageFilePath(path), path, content: "" };
}

describe("classifyPackageFilePath", () => {
  it("infers kind strictly from the path", () => {
    expect(classifyPackageFilePath("README.md")).toBe("readme");
    expect(classifyPackageFilePath("maister-package.yaml")).toBe("manifest");
    expect(classifyPackageFilePath("setup.sh")).toBe("setup");
    expect(classifyPackageFilePath("schemas/review.json")).toBe("schema");
    expect(classifyPackageFilePath("skills/x/SKILL.md")).toBe("skill");
    expect(classifyPackageFilePath("rules/RULE.md")).toBe("rule");
    expect(classifyPackageFilePath("agents/a.md")).toBe("agent_definition");
    expect(classifyPackageFilePath("scripts/run.sh")).toBe("script");
    expect(classifyPackageFilePath("templates/t.hbs")).toBe("template");
    expect(classifyPackageFilePath("notes.txt")).toBe("asset");
  });

  it("treats maister-agents/ as platform-agent definitions (structural editor)", () => {
    expect(classifyPackageFilePath("maister-agents/triager.md")).toBe(
      "agent_definition",
    );
  });

  it("leaves capability subagents as raw assets (not the platform-agent form)", () => {
    // capability/**/agents/*.md are Claude subagents materialized into .claude
    // at run — they are NOT platform-agents and must not reach the agent form.
    expect(classifyPackageFilePath("capability/agents/loop-critic.md")).toBe(
      "asset",
    );
  });
});

describe("buildFileTree", () => {
  it("groups path segments into nested folders with file leaves", () => {
    const tree = buildFileTree([
      file("skills/deploy/SKILL.md"),
      file("README.md"),
    ]);

    expect(tree).toEqual([
      {
        type: "folder",
        name: "skills",
        path: "skills",
        children: [
          {
            type: "folder",
            name: "deploy",
            path: "skills/deploy",
            children: [
              {
                type: "file",
                name: "SKILL.md",
                path: "skills/deploy/SKILL.md",
                kind: "skill",
              },
            ],
          },
        ],
      },
      {
        type: "file",
        name: "README.md",
        path: "README.md",
        kind: "readme",
      },
    ]);
  });

  it("orders folders before files and sorts alphabetically within a level", () => {
    const tree = buildFileTree([
      file("zeta.txt"),
      file("scripts/run.sh"),
      file("alpha.txt"),
      file("agents/a.md"),
    ]);

    expect(tree.map((node) => `${node.type}:${node.name}`)).toEqual([
      "folder:agents",
      "folder:scripts",
      "file:alpha.txt",
      "file:zeta.txt",
    ]);
  });

  it("merges multiple files under a shared folder and infers each leaf kind", () => {
    const tree = buildFileTree([
      file("schemas/review.json"),
      file("schemas/approve.json"),
    ]);

    const folder = tree[0];

    expect(folder.type).toBe("folder");

    if (folder.type !== "folder") throw new Error("expected folder");

    expect(folder.children.map((child) => child.name)).toEqual([
      "approve.json",
      "review.json",
    ]);
    expect(folder.children.every((child) => child.type === "file")).toBe(true);
    expect(
      folder.children.every(
        (child) => child.type === "file" && child.kind === "schema",
      ),
    ).toBe(true);
  });

  it("does not mutate the input files array", () => {
    const files = [file("b.txt"), file("a.txt")];
    const snapshot = files.map((entry) => entry.path);

    buildFileTree(files);

    expect(files.map((entry) => entry.path)).toEqual(snapshot);
  });
});

describe("validatePathEdit", () => {
  const files: AuthoredFlowPackageFile[] = [
    file("README.md"),
    file("skills/deploy/SKILL.md"),
    file("scripts/run.sh"),
  ];

  it("accepts a clean move and re-infers the kind from the new path", () => {
    const result = validatePathEdit(files, "scripts/run.sh", "skills/run.sh");

    expect(result).toEqual({
      ok: true,
      path: "skills/run.sh",
      kind: "skill",
    });
  });

  it("normalizes a dot-prefixed path on a successful edit", () => {
    const result = validatePathEdit(files, "README.md", "./docs/GUIDE.md");

    expect(result).toEqual({ ok: true, path: "docs/GUIDE.md", kind: "asset" });
  });

  it("rejects any path whose raw form contains a .. segment (server parity)", () => {
    expect(validatePathEdit(files, "README.md", "docs/../GUIDE.md")).toEqual({
      ok: false,
      code: "unsafe_path",
    });
  });

  it("rejects a parent-escaping path with unsafe_path", () => {
    expect(validatePathEdit(files, "README.md", "../escape.md")).toEqual({
      ok: false,
      code: "unsafe_path",
    });
  });

  it("rejects an absolute path with unsafe_path", () => {
    expect(validatePathEdit(files, "README.md", "/etc/passwd")).toEqual({
      ok: false,
      code: "unsafe_path",
    });
  });

  it("rejects a NUL-bearing path with unsafe_path", () => {
    const nul = String.fromCharCode(0);

    expect(validatePathEdit(files, "README.md", `bad${nul}name.md`)).toEqual({
      ok: false,
      code: "unsafe_path",
    });
  });

  it("rejects a path that collides with another file (duplicate_path)", () => {
    expect(validatePathEdit(files, "README.md", "scripts/run.sh")).toEqual({
      ok: false,
      code: "duplicate_path",
    });
  });

  it("rejects a path that turns an existing file into a folder prefix (path_conflict)", () => {
    expect(
      validatePathEdit(files, "README.md", "scripts/run.sh/extra.txt"),
    ).toEqual({ ok: false, code: "path_conflict" });
  });

  it("allows renaming a file to its own normalized path (self-edit is not a duplicate)", () => {
    const result = validatePathEdit(
      files,
      "skills/deploy/SKILL.md",
      "skills/deploy/SKILL.md",
    );

    expect(result).toEqual({
      ok: true,
      path: "skills/deploy/SKILL.md",
      kind: "skill",
    });
  });
});
