import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildPackageBom,
  installedPackageSource,
  type PackageSource,
} from "@/lib/queries/package-bom";

// getStudioPackageBom looks the install row up in the DB then delegates to the
// shared builder. Mock only the DB lookup; the disk reads run for real.
const dbState = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({ where: () => Promise.resolve(dbState.rows) }),
    }),
  }),
}));

import { getStudioPackageBom } from "@/lib/queries/packages";

const manifest = {
  spec: { flows: [{ id: "dev", path: "flows/dev" }], mcps: [{ id: "m1" }] },
  inventory: { skills: ["s1"], agents: ["a1"], platformAgents: ["p1"] },
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pkgbom-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  dbState.rows = [];
});

// Mirrors the on-disk shape of an installed package the BOM reads.
async function seedPackage(at: string): Promise<void> {
  await mkdir(join(at, "flows", "dev"), { recursive: true });
  await writeFile(
    join(at, "flows", "dev", "flow.yaml"),
    [
      "schemaVersion: 1",
      "name: dev",
      "steps:",
      "  - id: plan",
      "    type: agent",
      "    mode: new-session",
      "    prompt: build it",
      "  - id: build",
      "    type: cli",
      "    command: echo hi",
      "",
    ].join("\n"),
  );
  await mkdir(join(at, "skills", "s1", "references"), { recursive: true });
  await writeFile(
    join(at, "skills", "s1", "SKILL.md"),
    "---\nname: s1\ndescription: Use for architecture work.\n---\nx\n",
  );
  await writeFile(join(at, "skills", "s1", "references", "a.md"), "ref\n");
  await mkdir(join(at, "agents"), { recursive: true });
  await writeFile(
    join(at, "agents", "a1.md"),
    [
      "---",
      "name: a1",
      "description: An agent",
      "tools: Read, Bash",
      "model: inherit",
      "---",
      "Subagent prompt body.",
      "",
    ].join("\n"),
  );
  await mkdir(join(at, "maister-agents"), { recursive: true });
  await writeFile(
    join(at, "maister-agents", "p1.md"),
    [
      "---",
      "name: p1",
      "description: A platform agent",
      "runner: claude-code",
      "workspace: none",
      "mode: session",
      "triggers:",
      "  - manual",
      "risk_tier: read_only",
      "---",
      "Platform agent prompt body.",
      "",
    ].join("\n"),
  );
  await mkdir(join(at, "rules"), { recursive: true });
  await writeFile(join(at, "rules", "r1.md"), "rule\n");
}

describe("buildPackageBom (ADR-115 shared builder)", () => {
  it("enriches every kind from an installed source; agent carries NO runner", async () => {
    await seedPackage(root);

    const bom = await buildPackageBom(
      installedPackageSource({ id: "inst-1", installedPath: root, manifest }),
    );

    expect(bom.flows).toHaveLength(1);
    expect(bom.flows[0]).toMatchObject({
      id: "dev",
      path: "flows/dev",
      nodeCount: 2,
      gateCount: 0,
      engine: null,
    });
    expect(bom.flows[0].graph).not.toBeNull();
    expect(bom.skills).toEqual([
      {
        id: "s1",
        path: "skills/s1",
        fileCount: 2,
        subfolderCount: 1,
        description: "Use for architecture work.",
      },
    ]);
    expect(bom.platformAgents).toHaveLength(1);
    expect(bom.platformAgents[0]).toMatchObject({
      id: "p1",
      description: "A platform agent",
      triggers: ["manual"],
      riskTier: "read_only",
      workspace: "none",
    });
    expect("runner" in bom.platformAgents[0]).toBe(false);
    expect(bom.subagents).toEqual([
      { id: "a1", path: "agents/a1.md", description: "An agent" },
    ]);
    expect(bom.rules).toEqual([{ id: "r1.md", path: "rules/r1.md" }]);
    expect(bom.mcps).toEqual([{ id: "m1" }]);
  });

  it("derives mcps id-only from spec.mcps", async () => {
    const source: PackageSource = {
      logLabel: "mem",
      spec: { flows: [], mcps: [{ id: "alpha" }, { id: "beta" }] },
      inventory: { skills: [], agents: [], platformAgents: [] },
      listFiles: () =>
        Promise.resolve({ bundleMissing: false, files: [], flowYaml: null }),
      readFile: () => Promise.resolve({ state: "not-found" }),
      loadFlow: () => Promise.reject(new Error("no flows")),
    };

    const bom = await buildPackageBom(source);

    expect(bom.mcps).toEqual([{ id: "alpha" }, { id: "beta" }]);
    expect(bom.flows).toEqual([]);
  });

  it("degrades a malformed flow + missing bundle to id-only without throwing", async () => {
    const source: PackageSource = {
      logLabel: "mem",
      spec: { flows: [{ id: "dev", path: "flows/dev" }], mcps: [] },
      inventory: { skills: ["s1"], agents: ["a1"], platformAgents: ["p1"] },
      listFiles: () => Promise.resolve({ bundleMissing: true }),
      readFile: () => Promise.resolve({ state: "bundle-missing" }),
      loadFlow: () => Promise.reject(new Error("compile failure")),
    };

    const bom = await buildPackageBom(source);

    expect(bom.flows).toEqual([
      {
        id: "dev",
        path: "flows/dev",
        nodeCount: 0,
        gateCount: 0,
        engine: null,
        frontmatter: {
          title: null,
          summary: null,
          labels: [],
          routeWhen: null,
          links: [],
          sources: [],
        },
        graph: null,
      },
    ]);
    expect(bom.skills).toEqual([
      {
        id: "s1",
        path: "skills/s1",
        fileCount: 0,
        subfolderCount: 0,
        description: "",
      },
    ]);
    expect(bom.platformAgents).toEqual([
      {
        id: "p1",
        path: "maister-agents/p1.md",
        description: "",
        triggers: [],
        riskTier: "",
        workspace: "",
      },
    ]);
    expect(bom.subagents).toEqual([{ id: "a1", path: null, description: "" }]);
    expect(bom.rules).toEqual([]);
  });
});

describe("getStudioPackageBom characterization (ADR-115 refactor guard)", () => {
  it("installed BOM output is stable through the shared-builder refactor", async () => {
    await seedPackage(root);
    dbState.rows = [{ id: "inst-1", installedPath: root, manifest }];

    const bom = await getStudioPackageBom("inst-1");

    if (!bom) throw new Error("unexpected null bom");

    // The flow graph payload is large + position-laden; pin only the stable,
    // human-meaningful projection (the cards) byte-for-byte.
    expect({
      flows: bom.flows.map((f) => ({
        id: f.id,
        path: f.path,
        nodeCount: f.nodeCount,
        gateCount: f.gateCount,
        engine: f.engine,
        frontmatter: f.frontmatter,
        hasGraph: f.graph !== null,
      })),
      skills: bom.skills,
      subagents: bom.subagents,
      platformAgents: bom.platformAgents,
      mcps: bom.mcps,
      rules: bom.rules,
    }).toMatchSnapshot();
  });

  it("returns null for an unknown install", async () => {
    dbState.rows = [];

    expect(await getStudioPackageBom("missing")).toBeNull();
  });
});
