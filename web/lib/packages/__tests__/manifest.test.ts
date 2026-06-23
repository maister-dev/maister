import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isMaisterError } from "@/lib/errors";
import { loadMaisterPackageManifest } from "@/lib/packages/manifest";

const tmpDirs: string[] = [];

async function packageRoot(yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "maister-pkg-manifest-"));

  tmpDirs.push(dir);
  await writeFile(join(dir, "maister-package.yaml"), yaml, "utf8");

  return dir;
}

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

const VALID = `schemaVersion: 1
name: aif
metadata:
  title: "AI Factory"
  summary: "Spec-driven delivery flows."
flows:
  - { id: aif-dev, path: flows/dev }
  - { id: aif-bugfix, path: flows/bugfix }
capabilities:
  - { id: aif-bundle, path: capability }
mcps:
  - id: docs-search
    transport: http
    url: https://mcp.example.com/sse
    env: ["env:DOCS_TOKEN"]
restrictions:
  - { id: protect-docs, paths: ["docs/**"] }
`;

describe("loadMaisterPackageManifest", () => {
  it("round-trips a valid manifest with all sections", async () => {
    const root = await packageRoot(VALID);
    const manifest = await loadMaisterPackageManifest(root);

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.name).toBe("aif");
    expect(manifest.flows.map((f) => f.id)).toEqual(["aif-dev", "aif-bugfix"]);
    expect(manifest.flows[0]?.path).toBe("flows/dev");
    expect(manifest.capabilities).toEqual([
      { id: "aif-bundle", path: "capability" },
    ]);
    expect(manifest.mcps[0]?.transport).toBe("http");
    expect(manifest.restrictions[0]?.paths).toEqual(["docs/**"]);
  });

  it("defaults absent optional sections to empty arrays", async () => {
    const root = await packageRoot(
      `schemaVersion: 1\nname: solo\nflows:\n  - { id: only, path: flows/only }\n`,
    );
    const manifest = await loadMaisterPackageManifest(root);

    expect(manifest.capabilities).toEqual([]);
    expect(manifest.mcps).toEqual([]);
    expect(manifest.restrictions).toEqual([]);
  });

  it.each([
    ["escape path", "flows:\n  - { id: a, path: ../escape }"],
    ["absolute path", 'flows:\n  - { id: a, path: "/abs/path" }'],
    ["dot-dot inside", "flows:\n  - { id: a, path: flows/../../x }"],
  ])("rejects %s with CONFIG", async (_label, flowsBlock) => {
    const root = await packageRoot(
      `schemaVersion: 1\nname: p\n${flowsBlock}\n`,
    );

    await expect(loadMaisterPackageManifest(root)).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "CONFIG",
    );
  });

  it("accepts an empty flows list (empty/draft packages are valid — ADR-105)", async () => {
    const root = await packageRoot(`schemaVersion: 1\nname: p\nflows: []\n`);
    const manifest = await loadMaisterPackageManifest(root);

    expect(manifest.flows).toEqual([]);
  });

  it("rejects duplicate ids within a section with CONFIG", async () => {
    const root = await packageRoot(
      `schemaVersion: 1\nname: p\nflows:\n  - { id: dup, path: flows/a }\n  - { id: dup, path: flows/b }\n`,
    );

    await expect(loadMaisterPackageManifest(root)).rejects.toSatisfy(
      (e: unknown) =>
        isMaisterError(e) &&
        e.code === "CONFIG" &&
        /duplicate/i.test(e.message),
    );
  });

  it("rejects a flow id colliding with a capability id with CONFIG", async () => {
    const root = await packageRoot(
      `schemaVersion: 1\nname: p\nflows:\n  - { id: shared, path: flows/a }\ncapabilities:\n  - { id: shared, path: capability }\n`,
    );

    await expect(loadMaisterPackageManifest(root)).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "CONFIG",
    );
  });

  it("rejects an mcp env value that is not an env:NAME reference", async () => {
    const root = await packageRoot(
      `schemaVersion: 1\nname: p\nflows:\n  - { id: a, path: flows/a }\nmcps:\n  - { id: m, transport: http, url: "https://x", env: ["plaintext-secret"] }\n`,
    );

    await expect(loadMaisterPackageManifest(root)).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "CONFIG",
    );
  });

  it.each([
    ["stdio without command", "{ id: m, transport: stdio }"],
    ["http without url", "{ id: m, transport: http }"],
    [
      "stdio with url",
      '{ id: m, transport: stdio, command: npx, url: "https://x" }',
    ],
  ])("rejects transport-inconsistent mcp (%s) with CONFIG", async (_l, mcp) => {
    const root = await packageRoot(
      `schemaVersion: 1\nname: p\nflows:\n  - { id: a, path: flows/a }\nmcps:\n  - ${mcp}\n`,
    );

    await expect(loadMaisterPackageManifest(root)).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "CONFIG",
    );
  });

  it("throws CONFIG when maister-package.yaml is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maister-pkg-missing-"));

    tmpDirs.push(dir);
    await expect(loadMaisterPackageManifest(dir)).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "CONFIG",
    );
  });

  it("throws CONFIG on invalid YAML", async () => {
    const root = await packageRoot("schemaVersion: [unclosed\n");

    await expect(loadMaisterPackageManifest(root)).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "CONFIG",
    );
  });

  it("rejects unknown top-level keys (strict schema)", async () => {
    const root = await packageRoot(
      `schemaVersion: 1\nname: p\nversion: 1.0.0\nflows:\n  - { id: a, path: flows/a }\n`,
    );

    await expect(loadMaisterPackageManifest(root)).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "CONFIG",
    );
  });
});
