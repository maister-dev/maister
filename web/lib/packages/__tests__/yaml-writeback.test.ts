import type { ExportProjection } from "@/lib/project-config-persistence/types";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { loadProjectConfig } from "@/lib/config";
import { MaisterError } from "@/lib/errors";
import {
  patchProjectManifest,
  normalizedManifest,
  manifestMatches,
} from "@/lib/project-config-persistence/manifest";
import { serializeProjectConfig } from "@/lib/packages/yaml-writeback";

let workDir: string;
let yamlPath: string;

const SEED = `schemaVersion: 2
# Dogfood registration — comments MUST survive write-back.
project:
  name: myapp
  repo_path: /repos/myapp # inline comment
  main_branch: main
  branch_prefix: maister/
packages:
  - id: aif
    source: github.com/org/maister-plugins
    version: aif/v1.0.0
    path: packages/aif
flows: []
`;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "yaml-writeback-"));
  yamlPath = join(workDir, "maister.yaml");
  await writeFile(yamlPath, SEED, "utf8");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("serializeProjectConfig — project.public_branch_template", () => {
  const base = {
    name: "myapp",
    mainBranch: "main",
    branchPrefix: "maister/",
    defaultRunnerId: null,
    promotionMode: null,
  };

  it("omits the key when the column holds the default", () => {
    const doc = parseYaml(
      serializeProjectConfig({
        ...base,
        publicBranchTemplate: "feature/{task_key}-{slug}",
      }),
    );

    expect(doc.project).not.toHaveProperty("public_branch_template");
  });

  it("emits a non-default template, and it round-trips through the loader", async () => {
    const text = serializeProjectConfig({
      ...base,
      publicBranchTemplate: "wip/{task_key}-a{attempt}",
    });

    expect(parseYaml(text).project.public_branch_template).toBe(
      "wip/{task_key}-a{attempt}",
    );

    await writeFile(yamlPath, text);
    const cfg = await loadProjectConfig(yamlPath);

    expect(cfg.project.public_branch_template).toBe(
      "wip/{task_key}-a{attempt}",
    );
  });

  it("refuses an invalid template at load with CONFIG, before anything is registered", async () => {
    await writeFile(
      yamlPath,
      "schemaVersion: 2\nproject:\n  name: myapp\n  public_branch_template: feature/{bogus}\nflows: []\n",
    );

    const err = await loadProjectConfig(yamlPath).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MaisterError);
    expect((err as MaisterError).code).toBe("CONFIG");
    expect((err as MaisterError).message).toContain("public_branch_template");
  });
});

describe("reviewed manifest patching", () => {
  const rich = `# leading comment
schemaVersion: 2
project:
  name: myapp # project name
  default_runner: old-runner # runner note
  promotion:
    mode: pull_request # mode note
    remote: upstream
  unrelated: 'keep  spacing'
packages:
  # package owner
  - id: aif
    source: https://example.invalid/pkg
    version: aif/v1.0.0 # pin note
    path: packages/aif
  - id: detached
    # removed source rationale
    source: https://example.invalid/old
    version: v1 # detached note
flows:
  - id: standalone
    source: https://example.invalid/flow
    version: v1
    runner: standalone-runner
capabilities:
  mcps: []
  skills: []
  rules: []
  restrictions: []
  settings: []
  tools: []
  agent_definitions: []
  env_profiles: []
capability_imports:
  - id: imported
    source: https://example.invalid/caps
    version: v1
    trust: explicit
flow_roles:
  - ref: implement
    label: 'Keep me'
unknown: { formatting: [1,  2] }
`;
  const base: ExportProjection = {
    ...normalizedManifest(rich),
    packages: normalizedManifest(rich).packages.map((pin) => ({
      ...pin,
      resolvedRevision: "a".repeat(40),
    })),
  };

  it("IT-CPC-04: UTF-8 byte limits and existing newline style are exact", () => {
    const crlf = rich.replaceAll("\n", "\r\n");
    const changed = patchProjectManifest(crlf, { ...base, name: "Проект" });

    expect(changed).toContain("name: Проект # project name\r\n");
    expect(changed.replaceAll("\r\n", "")).not.toContain("\n");
    const atLimit = `${rich}#${"x".repeat(1024 * 1024 - Buffer.byteLength(rich) - 1)}`;

    expect(patchProjectManifest(atLimit, base)).toBe(atLimit);
    expect(() => patchProjectManifest(`${atLimit}x`, base)).toThrow(
      expect.objectContaining({ details: { reason: "manifest_too_large" } }),
    );
  });

  it("IT-CPC-07: patching project and package leaves preserves source-only sections and removed-entry comments", () => {
    const desired = {
      ...base,
      name: "New name",
      defaultRunnerId: null,
      promotionMode: null,
      packages: [
        { ...base.packages[0]!, version: "aif/v2.0.0", path: undefined },
      ],
    };
    const patched = patchProjectManifest(rich, desired);

    expect(patched.slice(patched.indexOf("flows:"))).toBe(
      rich.slice(rich.indexOf("flows:")),
    );
    expect(patched).toContain("name: New name # project name");
    expect(patched).toContain("version: aif/v2.0.0 # pin note");
    expect(patched).toContain("remote: upstream");
    expect(patched).toContain("unrelated: 'keep  spacing'");
    expect(patched).toContain("# runner note");
    expect(patched).toContain("# mode note");
    expect(patched).toContain("# detached note");
    expect(patched).toContain("# removed source rationale");
    expect(normalizedManifest(patched).packages).toEqual([
      {
        id: "aif",
        source: "https://example.invalid/pkg",
        version: "aif/v2.0.0",
      },
    ]);
    expect(manifestMatches(patched, desired)).toBe(true);
    const reset = patchProjectManifest(patched, {
      ...desired,
      defaultRunnerId: "new-runner",
      promotionMode: "local_merge",
    });

    expect(normalizedManifest(reset)).toMatchObject({
      defaultRunnerId: "new-runner",
      promotionMode: "local_merge",
    });
  });

  it("IT-CPC-03: equivalent defaults and package order are a byte-exact no-op; new manifests are schema valid", () => {
    expect(
      patchProjectManifest(rich, {
        ...base,
        packages: [...base.packages].reverse(),
      }),
    ).toBe(rich);
    const created = patchProjectManifest(null, {
      ...base,
      defaultRunnerId: null,
      promotionMode: null,
      packages: [],
    });

    expect(parseYaml(created).flows).toEqual([]);
    expect(
      manifestMatches(created, {
        ...base,
        defaultRunnerId: null,
        promotionMode: null,
        packages: [],
      }),
    ).toBe(true);
    expect(
      patchProjectManifest(
        created.replace(
          "  name:",
          "  main_branch: main\n  branch_prefix: maister/\n  name:",
        ),
        { ...base, defaultRunnerId: null, promotionMode: null, packages: [] },
      ),
    ).toContain("main_branch: main");
  });

  it("IT-CPC-07: replacing every attached package retains removed comments and inserts the new package set", () => {
    const desired = {
      ...base,
      packages: [
        {
          id: "replacement",
          source: "https://example.invalid/new",
          version: "v2",
          resolvedRevision: "b".repeat(40),
        },
      ],
    };
    const changed = patchProjectManifest(rich, desired);

    expect(manifestMatches(changed, desired)).toBe(true);
    expect(changed).toContain("# detached note");
    expect(changed).toContain("# pin note");
    expect(changed.slice(changed.indexOf("flows:"))).toBe(
      rich.slice(rich.indexOf("flows:")),
    );
  });

  it("IT-CPC-07: an unrelated unreferenced YAML anchor is preserved verbatim", () => {
    const anchored = rich.replace("unknown: {", "unknown: &keep {");
    const changed = patchProjectManifest(anchored, {
      ...base,
      name: "Changed",
    });

    expect(changed.slice(changed.indexOf("flows:"))).toBe(
      anchored.slice(anchored.indexOf("flows:")),
    );
  });

  it.each([
    rich.replace("schemaVersion: 2", "schemaVersion: 2\nschemaVersion: 2"),
    rich
      .replace("name: myapp", "name: &name myapp")
      .replace("unknown: { formatting: [1,  2] }", "unknown: *name"),
    rich.replace("project:\n", "project: [unsupported]\n"),
  ])(
    "IT-CPC-07: unsafe source structures refuse before any write",
    (source) => {
      expect(() =>
        patchProjectManifest(source, { ...base, name: "changed" }),
      ).toThrow(MaisterError);
    },
  );
});
