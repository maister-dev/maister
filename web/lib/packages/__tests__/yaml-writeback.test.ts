import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { writeBackPackagesPin } from "@/lib/packages/yaml-writeback";

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

describe("writeBackPackagesPin", () => {
  it("SET: adds a new entry, preserving comments", async () => {
    const result = await writeBackPackagesPin({
      maisterYamlPath: yamlPath,
      change: {
        op: "upsert",
        entry: {
          id: "core",
          source: "github.com/org/maister-plugins",
          version: "core/v0.1.0",
          path: "packages/core",
        },
      },
    });

    expect(result).toBe("ok");
    const text = await readFile(yamlPath, "utf8");

    expect(text).toContain("# Dogfood registration — comments MUST survive");
    expect(text).toContain("# inline comment");

    const parsed = parseYaml(text);

    expect(parsed.packages).toHaveLength(2);
    expect(parsed.packages[1]).toEqual({
      id: "core",
      source: "github.com/org/maister-plugins",
      version: "core/v0.1.0",
      path: "packages/core",
    });
  });

  it("re-SET: upserting an existing id rewrites the version pin", async () => {
    const result = await writeBackPackagesPin({
      maisterYamlPath: yamlPath,
      change: {
        op: "upsert",
        entry: {
          id: "aif",
          source: "github.com/org/maister-plugins",
          version: "aif/v2.0.0",
          path: "packages/aif",
        },
      },
    });

    expect(result).toBe("ok");
    const parsed = parseYaml(await readFile(yamlPath, "utf8"));

    expect(parsed.packages).toHaveLength(1);
    expect(parsed.packages[0].version).toBe("aif/v2.0.0");
  });

  it("CLEAR: remove deletes the entry and keeps the rest of the file", async () => {
    const result = await writeBackPackagesPin({
      maisterYamlPath: yamlPath,
      change: { op: "remove", id: "aif" },
    });

    expect(result).toBe("ok");
    const text = await readFile(yamlPath, "utf8");
    const parsed = parseYaml(text);

    expect(parsed.packages).toEqual([]);
    expect(parsed.project.name).toBe("myapp");
    expect(text).toContain("# Dogfood registration — comments MUST survive");
  });

  it("creates the packages[] block when absent", async () => {
    await writeFile(yamlPath, "schemaVersion: 2\nflows: []\n", "utf8");

    const result = await writeBackPackagesPin({
      maisterYamlPath: yamlPath,
      change: {
        op: "upsert",
        entry: { id: "aif", source: "s", version: "aif/v1.0.0" },
      },
    });

    expect(result).toBe("ok");
    const parsed = parseYaml(await readFile(yamlPath, "utf8"));

    expect(parsed.packages).toEqual([
      { id: "aif", source: "s", version: "aif/v1.0.0" },
    ]);
  });

  it("returns 'failed' (never throws) on an unreadable target", async () => {
    const result = await writeBackPackagesPin({
      maisterYamlPath: join(workDir, "missing-dir", "maister.yaml"),
      change: { op: "remove", id: "aif" },
    });

    expect(result).toBe("failed");
  });

  // ADR-093: a project registered with no maister.yaml has maisterYamlPath
  // null (DB is authoritative). Write-back is a benign no-op, not a failure.
  it("returns 'skipped' for a null path without touching the disk", async () => {
    const before = await readFile(yamlPath, "utf8");

    const result = await writeBackPackagesPin({
      maisterYamlPath: null,
      change: { op: "remove", id: "aif" },
    });

    expect(result).toBe("skipped");
    expect(await readFile(yamlPath, "utf8")).toBe(before);
  });
});
