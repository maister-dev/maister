/**
 * T2.4 — capability_imports[] loader validation + ref-id map extension (M14)
 *
 * Tests:
 *  - loadProjectConfig rejects duplicate capability_imports ids (CONFIG)
 *  - buildCapabilityRefIds folds import ids into every kind bucket so a node
 *    settings ref resolving to an opaque import package is accepted
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { buildCapabilityRefIds, loadProjectConfig } from "@/lib/config";
import { maisterYamlV2Schema } from "@/lib/config.schema";
import { isMaisterError } from "@/lib/errors";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "config-imports-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function baseYaml(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    project: { name: "myapp", main_branch: "main", branch_prefix: "maister/" },
    executors: [
      { id: "claude-sonnet", agent: "claude", model: "claude-sonnet-4-6" },
    ],
    default_executor: "claude-sonnet",
    flows: [],
  };
}

async function writeMaister(obj: unknown): Promise<string> {
  const p = join(workDir, "maister.yaml");

  await writeFile(p, stringifyYaml(obj), "utf8");

  return p;
}

describe("loadProjectConfig — capability_imports dup id (M14 T2.4)", () => {
  it("rejects duplicate capability_imports ids with CONFIG", async () => {
    const p = await writeMaister({
      ...baseYaml(),
      capability_imports: [
        { id: "dup", source: "github.com/org/a", version: "v1.0.0" },
        { id: "dup", source: "github.com/org/b", version: "v2.0.0" },
      ],
    });

    let caught: unknown;

    try {
      await loadProjectConfig(p);
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("CONFIG");
  });

  it("accepts distinct capability_imports ids", async () => {
    const p = await writeMaister({
      ...baseYaml(),
      capability_imports: [
        { id: "a", source: "github.com/org/a", version: "v1.0.0" },
        { id: "b", source: "github.com/org/b", version: "v2.0.0" },
      ],
    });

    await expect(loadProjectConfig(p)).resolves.toBeTruthy();
  });
});

describe("buildCapabilityRefIds — includes capability_imports ids (M14 T2.4)", () => {
  it("adds each import id to every kind bucket so any node ref can resolve to an import", () => {
    const cfg = maisterYamlV2Schema.parse({
      ...baseYaml(),
      capabilities: {
        mcps: [{ id: "github", command: "github-mcp-server" }],
        skills: [{ id: "aif-implement" }],
      },
      capability_imports: [
        {
          id: "aif-skills",
          source: "github.com/org/aif-skills",
          version: "v1.0.0",
        },
      ],
    });

    const sets = buildCapabilityRefIds(cfg);

    // capabilities-block ids stay in their own kind bucket
    expect(sets.mcp.has("github")).toBe(true);
    expect(sets.skill.has("aif-implement")).toBe(true);

    // an opaque import package can back a ref of any kind
    expect(sets.mcp.has("aif-skills")).toBe(true);
    expect(sets.skill.has("aif-skills")).toBe(true);
    expect(sets.restriction.has("aif-skills")).toBe(true);
    expect(sets.setting.has("aif-skills")).toBe(true);
  });

  it("with no imports the buckets contain only block ids", () => {
    const cfg = maisterYamlV2Schema.parse({
      ...baseYaml(),
      capabilities: { skills: [{ id: "only-skill" }] },
    });

    const sets = buildCapabilityRefIds(cfg);

    expect(sets.skill.has("only-skill")).toBe(true);
    expect(sets.mcp.has("only-skill")).toBe(false);
  });
});
