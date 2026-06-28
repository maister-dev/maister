import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectInventoryFromFiles,
  getLocalPackageBom,
  isMcpDescriptorPath,
} from "@/lib/local-packages/bom";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "localbom-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const abs = join(root, rel);

  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

describe("isMcpDescriptorPath (ADR-115 §D6)", () => {
  it("matches a direct mcps/*.yaml|yml child only", () => {
    expect(isMcpDescriptorPath("mcps/github.yaml")).toBe(true);
    expect(isMcpDescriptorPath("mcps/github.yml")).toBe(true);
    expect(isMcpDescriptorPath("mcps/nested/x.yaml")).toBe(false);
    expect(isMcpDescriptorPath("mcps/readme.md")).toBe(false);
    expect(isMcpDescriptorPath("skills/mcps/x.yaml")).toBe(false);
  });
});

describe("collectInventoryFromFiles (ADR-115 §D4 file-list inventory)", () => {
  it("discovers skills, capability subagents, and platform agents under both layouts", () => {
    const inv = collectInventoryFromFiles([
      { path: "skills/arch/SKILL.md" },
      { path: "skills/arch/references/a.md" },
      { path: "capability/cap1/skills/nested/SKILL.md" },
      { path: "capability/cap1/agents/sub1.md" },
      { path: "agents/legacy.md" },
      { path: "maister-agents/plat1.md" },
      { path: "maister-agents/plat2.md" },
      { path: "flows/dev/flow.yaml" },
      { path: "mcps/github.yaml" },
    ]);

    expect(inv.skills).toEqual(["arch", "nested"]);
    expect(inv.agents).toEqual(["legacy", "sub1"]);
    expect(inv.platformAgents).toEqual(["plat1", "plat2"]);
  });

  it("does not treat maister-agents as a subagent", () => {
    const inv = collectInventoryFromFiles([{ path: "maister-agents/p.md" }]);

    expect(inv.agents).toEqual([]);
    expect(inv.platformAgents).toEqual(["p"]);
  });
});

async function seedManifest(flows: string, mcps = ""): Promise<void> {
  await write(
    "maister-package.yaml",
    ["schemaVersion: 1", "name: local-pkg", flows, mcps, ""].join("\n"),
  );
}

describe("getLocalPackageBom (ADR-115 §D4/D5)", () => {
  it("builds a BOM over a working dir: nested skill, capability subagent, platform agent, mcp file", async () => {
    await seedManifest(
      ["flows:", "  - id: dev", "    path: flows/dev"].join("\n"),
    );
    await write(
      "flows/dev/flow.yaml",
      [
        "schemaVersion: 1",
        "name: dev",
        "steps:",
        "  - id: plan",
        "    type: agent",
        "    mode: new-session",
        "    prompt: go",
        "",
      ].join("\n"),
    );
    await write(
      "skills/arch/SKILL.md",
      "---\nname: arch\ndescription: Arch skill.\n---\nbody\n",
    );
    await write("skills/arch/references/x.md", "ref\n");
    await write(
      "capability/cap1/agents/sub1.md",
      "---\nname: sub1\ndescription: A subagent.\n---\nbody\n",
    );
    await write(
      "maister-agents/plat1.md",
      [
        "---",
        "name: plat1",
        "description: Plat agent.",
        "runner: claude-code",
        "workspace: none",
        "mode: session",
        "triggers:",
        "  - manual",
        "risk_tier: read_only",
        "---",
        "body",
        "",
      ].join("\n"),
    );
    await write("rules/r1.md", "rule\n");
    await write(
      "mcps/github.yaml",
      "id: github\ntransport: stdio\ncommand: x\n",
    );

    const bom = await getLocalPackageBom({
      slug: "local-pkg",
      workingDir: root,
    });

    expect(bom.flows).toHaveLength(1);
    expect(bom.flows[0]).toMatchObject({
      id: "dev",
      nodeCount: 1,
      gateCount: 0,
    });
    expect(bom.flows[0].graph).not.toBeNull();
    expect(bom.skills).toEqual([
      {
        id: "arch",
        path: "skills/arch",
        fileCount: 2,
        subfolderCount: 1,
        description: "Arch skill.",
      },
    ]);
    expect(bom.subagents).toEqual([
      {
        id: "sub1",
        path: "capability/cap1/agents/sub1.md",
        description: "A subagent.",
      },
    ]);
    expect(bom.platformAgents[0]).toMatchObject({
      id: "plat1",
      description: "Plat agent.",
      triggers: ["manual"],
      workspace: "none",
    });
    expect(bom.rules).toEqual([{ id: "r1.md", path: "rules/r1.md" }]);
    // MCP file (D6) surfaces even though the manifest declares none.
    expect(bom.mcps).toEqual([{ id: "github" }]);
  });

  it("unions manifest-declared mcps with mcps/*.yaml file stems (deduped)", async () => {
    await seedManifest(
      "flows: []",
      [
        "mcps:",
        "  - id: github",
        "    transport: stdio",
        "    command: x",
      ].join("\n"),
    );
    await write("mcps/github.yaml", "id: github\n");
    await write("mcps/linear.yaml", "id: linear\n");

    const bom = await getLocalPackageBom({
      slug: "local-pkg",
      workingDir: root,
    });

    expect(bom.mcps).toEqual([{ id: "github" }, { id: "linear" }]);
  });

  it("degrades a malformed manifest to a files-only BOM without throwing", async () => {
    await write("maister-package.yaml", "name: [unterminated\n");
    await write("rules/r1.md", "rule\n");

    const bom = await getLocalPackageBom({
      slug: "local-pkg",
      workingDir: root,
    });

    expect(bom.flows).toEqual([]);
    expect(bom.mcps).toEqual([]);
    expect(bom.rules).toEqual([{ id: "r1.md", path: "rules/r1.md" }]);
  });

  it("returns an empty BOM for a missing working dir (no throw)", async () => {
    const bom = await getLocalPackageBom({
      slug: "gone",
      workingDir: join(root, "does-not-exist"),
    });

    expect(bom.flows).toEqual([]);
    expect(bom.skills).toEqual([]);
    expect(bom.subagents).toEqual([]);
    expect(bom.platformAgents).toEqual([]);
    expect(bom.rules).toEqual([]);
    expect(bom.mcps).toEqual([]);
  });
});
