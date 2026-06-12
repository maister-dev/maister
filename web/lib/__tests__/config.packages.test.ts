import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadProjectConfig } from "@/lib/config";
import { isMaisterError } from "@/lib/errors";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "config-packages-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeFixture(content: string): Promise<string> {
  const path = join(workDir, "maister.yaml");

  await writeFile(path, content, "utf8");

  return path;
}

const BASE = `schemaVersion: 2
project:
  name: myapp
  repo_path: /repos/myapp
  main_branch: main
  branch_prefix: maister/
  default_runner: claude-code
flows:
  - id: bugfix
    source: github.com/x/y
    version: v1.0.0
`;

describe("loadProjectConfig packages[] (ADR-088)", () => {
  it("parses git + file:// package entries incl. slash-tag versions and path", async () => {
    const path = await writeFixture(
      `${BASE}packages:
  - id: aif
    source: github.com/org/maister-plugins
    version: aif/v2.0.0
    path: packages/aif
  - id: local-pkg
    source: file:///abs/dir/maister-plugins
    version: local-dev
`,
    );
    const cfg = await loadProjectConfig(path);

    expect(cfg.packages).toHaveLength(2);
    expect(cfg.packages[0]).toEqual({
      id: "aif",
      source: "github.com/org/maister-plugins",
      version: "aif/v2.0.0",
      path: "packages/aif",
    });
    expect(cfg.packages[1]?.path).toBeUndefined();
  });

  it("defaults packages to [] for flows[]-only configs (backward compat)", async () => {
    const cfg = await loadProjectConfig(await writeFixture(BASE));

    expect(cfg.packages).toEqual([]);
  });

  it.each([
    ["escape path", "path: ../escape"],
    ["absolute path", 'path: "/abs"'],
  ])("rejects %s with CONFIG", async (_label, pathLine) => {
    const fixture = await writeFixture(
      `${BASE}packages:
  - id: aif
    source: github.com/org/maister-plugins
    version: aif/v2.0.0
    ${pathLine}
`,
    );

    await expect(loadProjectConfig(fixture)).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "CONFIG",
    );
  });

  it.each([
    ["dot-dot version", "v1..2"],
    ["leading-slash version", "/v1"],
    ["leading-dash version", "-v1"],
  ])("rejects %s with CONFIG", async (_label, version) => {
    const fixture = await writeFixture(
      `${BASE}packages:
  - id: aif
    source: github.com/org/maister-plugins
    version: "${version}"
`,
    );

    await expect(loadProjectConfig(fixture)).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "CONFIG",
    );
  });

  it("rejects duplicate packages ids with CONFIG", async () => {
    const fixture = await writeFixture(
      `${BASE}packages:
  - { id: aif, source: github.com/a/b, version: aif/v1.0.0 }
  - { id: aif, source: github.com/c/d, version: aif/v2.0.0 }
`,
    );

    await expect(loadProjectConfig(fixture)).rejects.toSatisfy(
      (e: unknown) =>
        isMaisterError(e) &&
        e.code === "CONFIG" &&
        /Duplicate packages id/.test(e.message),
    );
  });

  it.each([
    ["flows[]", "bugfix"],
    ["capability_imports[]", "shared-bundle"],
  ])("rejects a packages id colliding with %s with CONFIG", async (_l, id) => {
    const fixture = await writeFixture(
      `${BASE}capability_imports:
  - { id: shared-bundle, source: github.com/x/caps, version: v1.0.0 }
packages:
  - { id: ${id}, source: github.com/a/b, version: pkg/v1.0.0 }
`,
    );

    await expect(loadProjectConfig(fixture)).rejects.toSatisfy(
      (e: unknown) =>
        isMaisterError(e) && e.code === "CONFIG" && /collides/.test(e.message),
    );
  });
});
