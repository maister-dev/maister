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
    // ADR-179 (D34): the legacy list is folded to a map ONCE, at load, so
    // `attach.ts` and Studio see exactly one shape.
    expect(manifest.mcps[0]?.env).toEqual({ DOCS_TOKEN: "env:DOCS_TOKEN" });
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

  // OBSOLETE under ADR-179 (D1/D4): a literal is accepted in the MAP form — it
  // is the operator's declaration that the value is not a secret. The LIST form
  // is still references-only (a bare list entry has no key to pair with, so it
  // must name a variable). Replaced by the four cases below.
  it("rejects a LIST entry that is not an env:NAME reference", async () => {
    const root = await packageRoot(
      `schemaVersion: 1\nname: p\nflows:\n  - { id: a, path: flows/a }\nmcps:\n  - { id: m, transport: http, url: "https://x", env: ["plaintext-secret"] }\n`,
    );

    await expect(loadMaisterPackageManifest(root)).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "CONFIG",
    );
  });

  it("accepts the MAP form, with a literal and lowercase names", async () => {
    const root = await packageRoot(
      `schemaVersion: 1\nname: p\nflows:\n  - { id: a, path: flows/a }\nmcps:\n  - id: m\n    transport: stdio\n    command: npx\n    env:\n      DOCS_TOKEN: env:DOCS_TOKEN\n      fastmcp_log_level: ERROR\n`,
    );
    const manifest = await loadMaisterPackageManifest(root);

    // The pre-ADR-179 rule was uppercase-only and prefix-mandatory; the shared
    // grammar relaxes both.
    expect(manifest.mcps[0]?.env).toEqual({
      DOCS_TOKEN: "env:DOCS_TOKEN",
      fastmcp_log_level: "ERROR",
    });
  });

  it("produces IDENTICAL material from the list and map forms", async () => {
    const list = await loadMaisterPackageManifest(
      await packageRoot(
        `schemaVersion: 1\nname: p\nflows:\n  - { id: a, path: flows/a }\nmcps:\n  - { id: m, transport: stdio, command: npx, env: ["env:DOCS_TOKEN"] }\n`,
      ),
    );
    const map = await loadMaisterPackageManifest(
      await packageRoot(
        `schemaVersion: 1\nname: p\nflows:\n  - { id: a, path: flows/a }\nmcps:\n  - id: m\n    transport: stdio\n    command: npx\n    env:\n      DOCS_TOKEN: env:DOCS_TOKEN\n`,
      ),
    );

    expect(list.mcps[0]?.env).toEqual(map.mcps[0]?.env);
  });

  it("accepts headers + bearerTokenEnv on an http template", async () => {
    const root = await packageRoot(
      `schemaVersion: 1\nname: p\nflows:\n  - { id: a, path: flows/a }\nmcps:\n  - id: m\n    transport: http\n    url: "https://x"\n    headers:\n      X-Tenant: acme\n    bearerTokenEnv: env:MCP_TOKEN\n`,
    );
    const manifest = await loadMaisterPackageManifest(root);

    expect(manifest.mcps[0]?.headers).toEqual({ "X-Tenant": "acme" });
    expect(manifest.mcps[0]?.bearerTokenEnv).toBe("env:MCP_TOKEN");
  });

  it.each([
    [
      "bearerTokenEnv on stdio",
      '{ id: m, transport: stdio, command: npx, bearerTokenEnv: "env:T" }',
    ],
    [
      "bearerTokenEnv beside an Authorization header",
      '{ id: m, transport: http, url: "https://x", headers: { Authorization: "Basic a" }, bearerTokenEnv: "env:T" }',
    ],
    [
      "headers on a requirement-only entry",
      '{ id: m, headers: { "X-Tenant": "acme" } }',
    ],
    [
      "a malformed env: value",
      '{ id: m, transport: stdio, command: npx, env: { GH: "env:1BAD" } }',
    ],
  ])("rejects %s with CONFIG", async (_l, mcp) => {
    const root = await packageRoot(
      `schemaVersion: 1\nname: p\nflows:\n  - { id: a, path: flows/a }\nmcps:\n  - ${mcp}\n`,
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
