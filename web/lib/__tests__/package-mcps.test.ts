/**
 * M27/T-C6 (C6-top, ADR-069): flow-package `flow.yaml` declares a top-level
 * `mcps: string[]` (capability ref ids) — the package-level REQUIRED MCP
 * declaration. The hard-gate (`validateGraphManifest` via `loadFlowManifest`)
 * rejects an unknown package mcp ref with `CONFIG`, sharing one helper with the
 * launch gate (R-CONTRACT). Config SET/CLEAR/re-SET symmetry: a declared ref is
 * checked; a removed declaration is no longer required.
 *
 * The KNOWN-but-unmaterializable required-MCP refusal is T-C8 (separate); this
 * task is the unknown-ref (registry membership) gate only.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { firstUnknownPackageMcpRef, loadFlowManifest } from "@/lib/config";
import { flowYamlV1Schema } from "@/lib/config.schema";
import { isMaisterError } from "@/lib/errors";

describe("flowYamlV1Schema top-level mcps (C6-top)", () => {
  function baseGraph(): Record<string, unknown> {
    return {
      schemaVersion: 1,
      name: "pkg-mcp-flow",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "implement",
          type: "ai_coding",
          action: { prompt: "/aif-implement" },
          transitions: { success: "done" },
        },
      ],
    };
  }

  it("parses a top-level mcps: string[] declaration", () => {
    const parsed = flowYamlV1Schema.parse({ ...baseGraph(), mcps: ["github"] });

    expect(parsed.mcps).toEqual(["github"]);
  });

  it("omits mcps when absent (back-compat)", () => {
    const parsed = flowYamlV1Schema.parse(baseGraph());

    expect(parsed.mcps).toBeUndefined();
  });

  it("rejects a non-string mcps entry", () => {
    expect(() =>
      flowYamlV1Schema.parse({ ...baseGraph(), mcps: [123] }),
    ).toThrow();
  });
});

describe("firstUnknownPackageMcpRef (C6-top)", () => {
  it("returns the first ref absent from the mcp registry", () => {
    expect(
      firstUnknownPackageMcpRef(["github", "ghost"], new Set(["github"])),
    ).toBe("ghost");
  });

  it("returns null when every declared ref is known", () => {
    expect(
      firstUnknownPackageMcpRef(["github"], new Set(["github", "postgres"])),
    ).toBeNull();
  });

  it("returns null for an undefined or empty declaration (CLEAR)", () => {
    expect(firstUnknownPackageMcpRef(undefined, new Set())).toBeNull();
    expect(firstUnknownPackageMcpRef([], new Set())).toBeNull();
  });
});

describe("loadFlowManifest — package mcp hard-gate SET/CLEAR (C6-top)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "package-mcps-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function writeGraph(
    name: string,
    packageMcps: string[] | undefined,
  ): Promise<string> {
    const manifest: Record<string, unknown> = {
      schemaVersion: 1,
      name: "pkg-mcp-flow",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "implement",
          type: "ai_coding",
          action: { prompt: "/aif-implement" },
          transitions: { success: "done" },
        },
      ],
    };

    if (packageMcps !== undefined) manifest.mcps = packageMcps;

    const path = join(workDir, name);

    await writeFile(path, stringifyYaml(manifest), "utf8");

    return path;
  }

  async function expectConfig(path: string, mcp: string[]): Promise<void> {
    let caught: unknown;

    try {
      await loadFlowManifest(path, {
        capabilityRefIds: { mcp, skill: [], restriction: [], setting: [] },
      });
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("CONFIG");
  }

  it("SET: declared package mcp absent from the registry → CONFIG", async () => {
    const path = await writeGraph("set-unknown.yaml", ["ghost-mcp"]);

    await expectConfig(path, ["other-mcp"]);
  });

  it("SET: declared package mcp present in the registry → loads", async () => {
    const path = await writeGraph("set-known.yaml", ["github"]);

    const manifest = await loadFlowManifest(path, {
      capabilityRefIds: {
        mcp: ["github"],
        skill: [],
        restriction: [],
        setting: [],
      },
    });

    expect(manifest.mcps).toEqual(["github"]);
  });

  it("CLEAR: no package mcp declaration → loads even with an empty registry", async () => {
    const path = await writeGraph("clear.yaml", undefined);

    const manifest = await loadFlowManifest(path, {
      capabilityRefIds: { mcp: [], skill: [], restriction: [], setting: [] },
    });

    expect(manifest.mcps).toBeUndefined();
  });

  it("re-SET: re-adding the declaration makes it required again → CONFIG", async () => {
    const path = await writeGraph("re-set.yaml", ["ghost-mcp"]);

    await expectConfig(path, []);
  });

  it("undefined capabilityRefIds → no package mcp check (back-compat)", async () => {
    const path = await writeGraph("back-compat.yaml", ["ghost-mcp"]);

    const manifest = await loadFlowManifest(path);

    expect(manifest.mcps).toEqual(["ghost-mcp"]);
  });
});
