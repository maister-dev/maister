import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  installAuthoredFlowPackageBridge,
  localDirectoryContentDigest,
} from "@/lib/flows";
import {
  createAuthoredFlowPackageBody,
  readAuthoredFlowPackageDirectory,
  validateAuthoredFlowPackageBody,
  writeAuthoredFlowPackageDirectory,
} from "@/lib/flows/package-authoring";

describe("authored Flow package body validation", () => {
  it("normalizes a valid authored Flow package body", () => {
    const body = validateAuthoredFlowPackageBody(
      createAuthoredFlowPackageBody({
        flowYaml: validFlowYaml(),
        packageMetadata: {
          slug: "release-review",
          name: "Release Review",
        },
        files: [
          {
            kind: "readme",
            path: "README.md",
            content: "# Release Review\n",
          },
          {
            kind: "setup",
            path: "setup.sh",
            content: "#!/usr/bin/env bash\nexit 0\n",
          },
        ],
      }),
    );

    expect(body.validation.status).toBe("valid");
    expect(body.manifest?.name).toBe("release-review");
    expect(body.validation.issueCount).toBe(0);
    expect(body.validation.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(body.files.map((file) => file.path)).toEqual([
      "README.md",
      "setup.sh",
    ]);
  });

  it("marks malformed YAML invalid without throwing", () => {
    const body = validateAuthoredFlowPackageBody(
      createAuthoredFlowPackageBody({
        flowYaml: "{",
        packageMetadata: { slug: "bad-yaml", name: "Bad YAML" },
        files: [],
      }),
    );

    expect(body.validation.status).toBe("invalid");
    expect(body.validation.issues[0]).toMatchObject({
      code: "yaml_parse",
      path: "flow.yaml",
    });
  });

  it("marks schema-invalid manifests invalid", () => {
    const body = validateAuthoredFlowPackageBody(
      createAuthoredFlowPackageBody({
        flowYaml: "foo: bar\n",
        packageMetadata: { slug: "bad-schema", name: "Bad Schema" },
        files: [],
      }),
    );

    expect(body.validation.status).toBe("invalid");
    expect(
      body.validation.issues.some((issue) => issue.code === "schema"),
    ).toBe(true);
  });

  it("marks graph-invalid manifests invalid", () => {
    const body = validateAuthoredFlowPackageBody(
      createAuthoredFlowPackageBody({
        flowYaml: graphInvalidFlowYaml(),
        packageMetadata: { slug: "bad-graph", name: "Bad Graph" },
        files: [],
      }),
    );

    expect(body.validation.status).toBe("invalid");
    expect(body.validation.issues.some((issue) => issue.code === "graph")).toBe(
      true,
    );
  });

  it("rejects unsafe and duplicate package file paths", () => {
    const body = validateAuthoredFlowPackageBody(
      createAuthoredFlowPackageBody({
        flowYaml: validFlowYaml(),
        packageMetadata: { slug: "unsafe", name: "Unsafe" },
        files: [
          { kind: "readme", path: "/README.md", content: "" },
          { kind: "schema", path: "schemas/review.json", content: "{}" },
          { kind: "schema", path: "schemas/./review.json", content: "{}" },
          { kind: "script", path: "../escape.sh", content: "" },
        ],
      }),
    );

    expect(body.validation.status).toBe("invalid");
    expect(body.validation.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["unsafe_path", "duplicate_path"]),
    );
  });

  it("rejects package file paths that collide as file and directory", () => {
    const body = validateAuthoredFlowPackageBody(
      createAuthoredFlowPackageBody({
        flowYaml: validFlowYaml(),
        packageMetadata: { slug: "path-collision", name: "Path collision" },
        files: [
          { kind: "readme", path: "docs", content: "# Docs\n" },
          { kind: "readme", path: "docs/readme.md", content: "# Docs\n" },
        ],
      }),
    );

    expect(body.validation.status).toBe("invalid");
    expect(body.validation.issues.map((issue) => issue.code)).toContain(
      "path_conflict",
    );
  });

  it("rejects package file paths with original dot-dot segments", () => {
    const body = validateAuthoredFlowPackageBody(
      createAuthoredFlowPackageBody({
        flowYaml: validFlowYaml(),
        packageMetadata: { slug: "dotdot", name: "Dotdot" },
        files: [
          { kind: "schema", path: "schemas/../setup.sh", content: "" },
          { kind: "script", path: "scripts\\..\\setup.sh", content: "" },
        ],
      }),
    );

    expect(body.validation.status).toBe("invalid");
    expect(body.validation.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["unsafe_path"]),
    );
  });

  it("marks unsupported file kinds invalid while keeping a safe stored kind", () => {
    const body = validateAuthoredFlowPackageBody(
      createAuthoredFlowPackageBody({
        flowYaml: validFlowYaml(),
        packageMetadata: { slug: "unsupported", name: "Unsupported" },
        files: [
          {
            kind: "bogus" as never,
            path: "adapters/codex.json",
            content: "{}\n",
          },
        ],
      }),
    );

    expect(body.validation.status).toBe("invalid");
    expect(body.validation.issues.map((issue) => issue.code)).toContain(
      "unsupported_kind",
    );
    expect(body.files).toEqual([
      {
        kind: "asset",
        path: "adapters/codex.json",
        content: "{}\n",
      },
    ]);
  });

  // QUARANTINED (T1/T2 restructure: plugins/aif is no longer a single flat authored
  // flow package — it is now capability/ + flows/<name>/. This canonical-import
  // assertion is rewritten/replaced in T7. See
  // .ai-factory/plans/feature-aif-flow-package.md (T4 inc3 note).
  it.skip("imports the canonical AIF package artifacts", async () => {
    const body = await readAuthoredFlowPackageDirectory("../plugins/aif");

    expect(body.validation.status).toBe("valid");
    expect(body.files.map((file) => `${file.kind}:${file.path}`)).toEqual(
      expect.arrayContaining([
        "readme:README.md",
        "setup:setup.sh",
        "schema:schemas/review.json",
        "skill:skills/aif/SKILL.md",
        "rule:rules/base.md",
        "agent_definition:agents/coordinator.md",
        "script:scripts/aif-flow.sh",
      ]),
    );
  });

  it("preserves unclassified package files as portable assets", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "maister-package-assets-"));
    const parent = await mkdtemp(join(tmpdir(), "maister-package-assets-out-"));
    const outputDir = join(parent, "exported");

    await writeFile(join(sourceDir, "flow.yaml"), validFlowYaml(), "utf8");
    await mkdir(join(sourceDir, "adapters"), { recursive: true });
    await writeFile(
      join(sourceDir, "adapters/codex.json"),
      '{"adapter":"codex"}\n',
      "utf8",
    );

    const body = await readAuthoredFlowPackageDirectory(sourceDir);

    expect(body.files.map((file) => `${file.kind}:${file.path}`)).toContain(
      "asset:adapters/codex.json",
    );

    await writeAuthoredFlowPackageDirectory(body, outputDir);

    await expect(
      readFile(join(outputDir, "adapters/codex.json"), "utf8"),
    ).resolves.toBe('{"adapter":"codex"}\n');
  });

  it("changes the local package content digest when non-manifest bytes change", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "maister-package-digest-"));

    await writeFile(join(sourceDir, "flow.yaml"), validFlowYaml(), "utf8");
    await writeFile(
      join(sourceDir, "setup.sh"),
      "#!/usr/bin/env bash\nexit 0\n",
      "utf8",
    );

    const firstDigest = await localDirectoryContentDigest(sourceDir);

    await writeFile(
      join(sourceDir, "setup.sh"),
      "#!/usr/bin/env bash\nexit 1\n",
      "utf8",
    );

    const secondDigest = await localDirectoryContentDigest(sourceDir);

    expect(firstDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(secondDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(secondDigest).not.toBe(firstDigest);
  });

  it("exports a valid authored Flow package to a portable directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "maister-package-"));
    const outputDir = join(parent, "exported");
    const body = validateAuthoredFlowPackageBody(
      createAuthoredFlowPackageBody({
        flowYaml: validFlowYaml(),
        packageMetadata: {
          slug: "release-review",
          name: "Release Review",
        },
        files: [
          {
            kind: "readme",
            path: "README.md",
            content: "# Release Review\n",
          },
        ],
      }),
    );

    await writeAuthoredFlowPackageDirectory(body, outputDir);

    await expect(readFile(join(outputDir, "flow.yaml"), "utf8")).resolves.toBe(
      validFlowYaml(),
    );
    await expect(readFile(join(outputDir, "README.md"), "utf8")).resolves.toBe(
      "# Release Review\n",
    );
  });

  it("refuses to export invalid authored Flow packages", async () => {
    const parent = await mkdtemp(join(tmpdir(), "maister-package-invalid-"));
    const body = validateAuthoredFlowPackageBody(
      createAuthoredFlowPackageBody({
        flowYaml: "foo: bar\n",
        packageMetadata: { slug: "bad", name: "Bad" },
        files: [],
      }),
    );

    await expect(
      writeAuthoredFlowPackageDirectory(body, join(parent, "exported")),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("refuses package directories without flow.yaml", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "maister-package-empty-"));

    await writeFile(join(sourceDir, "README.md"), "# Missing Flow\n");

    await expect(
      readAuthoredFlowPackageDirectory(sourceDir),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("uses the directory slug when flow.yaml name is a display label", async () => {
    const parent = await mkdtemp(join(tmpdir(), "maister-package-slug-"));
    const sourceDir = join(parent, "bugfix");

    await mkdir(sourceDir);
    await writeFile(join(sourceDir, "flow.yaml"), validFlowYaml("Bugfix"));

    const body = await readAuthoredFlowPackageDirectory(sourceDir);

    expect(body.packageMetadata).toMatchObject({
      slug: "bugfix",
      name: "Bugfix",
    });
    expect(body.validation.status).toBe("valid");
  });

  it("refuses package directories with non-text artifact bytes", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "maister-package-binary-"));

    await writeFile(join(sourceDir, "flow.yaml"), validFlowYaml(), "utf8");
    await mkdir(join(sourceDir, "assets"), { recursive: true });
    await writeFile(
      join(sourceDir, "assets/logo.bin"),
      Uint8Array.from([0xff, 0xfe, 0xfd]),
    );

    await expect(
      readAuthoredFlowPackageDirectory(sourceDir),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("refuses authored bridge installs before generic install when package bytes are invalid", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "maister-package-bridge-"));

    await writeFile(join(sourceDir, "flow.yaml"), validFlowYaml(), "utf8");
    await mkdir(join(sourceDir, "assets"), { recursive: true });
    await writeFile(
      join(sourceDir, "assets/logo.bin"),
      Uint8Array.from([0xff, 0xfe, 0xfd]),
    );

    await expect(
      installAuthoredFlowPackageBridge({
        source: sourceDir,
        version: "authored-local",
        projectId: "project-1",
        projectSlug: "demo",
        flowId: "aif",
        workspaceRoot: sourceDir,
        db: {},
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("refuses authored bridge installs before generic install when package entries are symlinks", async () => {
    const parent = await mkdtemp(join(tmpdir(), "maister-package-symlink-"));
    const sourceDir = join(parent, "symlinked-package");
    const outsideSetup = join(parent, "outside-setup.sh");

    await mkdir(sourceDir);
    await writeFile(join(sourceDir, "flow.yaml"), validFlowYaml(), "utf8");
    await writeFile(outsideSetup, "#!/usr/bin/env bash\nexit 0\n", "utf8");
    await symlink(outsideSetup, join(sourceDir, "setup.sh"));

    await expect(
      installAuthoredFlowPackageBridge({
        source: sourceDir,
        version: "authored-local",
        projectId: "project-1",
        projectSlug: "demo",
        flowId: "aif-symlink",
        workspaceRoot: sourceDir,
        db: {},
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("installs authored bridge packages from relative source directories as local bytes", async () => {
    const sourceDir = await mkdtemp(
      join(tmpdir(), "maister-package-relative-"),
    );
    const parent = await mkdtemp(
      join(tmpdir(), "maister-package-relative-root-"),
    );
    const relativeSource = "relative-package";
    const relativeSourceDir = join(parent, relativeSource);
    const calls: string[] = [];
    let insertCallCount = 0;
    const db = {
      insert: () => ({
        values: () => {
          insertCallCount += 1;

          return {
            onConflictDoNothing: () => ({
              returning: async () => {
                calls.push("insert-revision");

                return [{ id: "revision-1" }];
              },
            }),
            onConflictDoUpdate: () => ({
              returning: async () => {
                calls.push("upsert-flow");

                return [{ id: `flow-${insertCallCount}` }];
              },
            }),
          };
        },
      }),
      select: () => ({
        from: () => ({
          where: async () => [{ setupStatus: "not_required" }],
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => {
            calls.push("update-revision");
          },
        }),
      }),
    };

    await writeFile(join(sourceDir, "flow.yaml"), validFlowYaml(), "utf8");
    await writeAuthoredFlowPackageDirectory(
      await readAuthoredFlowPackageDirectory(sourceDir),
      relativeSourceDir,
    );

    const previousCwd = process.cwd();
    const previousHome = process.env.HOME;

    process.env.HOME = parent;
    process.chdir(parent);
    try {
      const result = await installAuthoredFlowPackageBridge({
        source: relativeSource,
        version: "authored-local",
        projectId: "project-1",
        projectSlug: "demo",
        flowId: "aif-relative",
        workspaceRoot: parent,
        db,
      });

      expect(result.trustStatus).toBe("untrusted");
      expect(result.enablementState).toBe("Installed");
      expect(result.installedPath).toMatch(/\.maister\/flows\/aif-relative@/);
      await expect(
        readFile(join(result.installedPath, "flow.yaml"), "utf8"),
      ).resolves.toBe(validFlowYaml());
      expect(calls).toContain("insert-revision");
      expect(calls).toContain("update-revision");
      expect(calls).toContain("upsert-flow");
    } finally {
      process.chdir(previousCwd);
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });
});

function validFlowYaml(name = "release-review"): string {
  return [
    "schemaVersion: 1",
    `name: ${JSON.stringify(name)}`,
    "compat:",
    "  engine_min: 1.1.0",
    "nodes:",
    "  - id: plan",
    "    type: ai_coding",
    "    action:",
    "      prompt: Plan",
    "    transitions:",
    "      success: done",
    "",
  ].join("\n");
}

function graphInvalidFlowYaml(): string {
  return [
    "schemaVersion: 1",
    "name: release-review",
    "compat:",
    "  engine_min: 1.1.0",
    "nodes:",
    "  - id: plan",
    "    type: ai_coding",
    "    action:",
    "      prompt: Plan",
    "    transitions:",
    "      success: missing",
    "",
  ].join("\n");
}
