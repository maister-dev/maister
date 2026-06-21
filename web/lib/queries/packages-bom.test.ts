import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getStudioPackageBom looks the install row up in the DB then reads the package
// off disk. Mock only the DB lookup (a fake install row pointing at a tmp dir);
// the flow compile, file walk, and agent parse run for real against the fixture.
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
  spec: { flows: [{ id: "dev", path: "flows/dev" }], mcps: [] },
  inventory: { skills: ["s1"], agents: ["a1"], platformAgents: ["p1"] },
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bom-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  dbState.rows = [];
});

async function seedPackage(): Promise<void> {
  await mkdir(join(root, "flows", "dev"), { recursive: true });
  await writeFile(
    join(root, "flows", "dev", "flow.yaml"),
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
  await mkdir(join(root, "skills", "s1", "references"), { recursive: true });
  await writeFile(
    join(root, "skills", "s1", "SKILL.md"),
    "---\nname: s1\n---\nx\n",
  );
  await writeFile(join(root, "skills", "s1", "references", "a.md"), "ref\n");
  // Capability subagent (inventory.agents) — read leniently for its description.
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(
    join(root, "agents", "a1.md"),
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
  // Platform-agent (inventory.platformAgents) at the package-root maister-agents/.
  await mkdir(join(root, "maister-agents"), { recursive: true });
  await writeFile(
    join(root, "maister-agents", "p1.md"),
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
  await mkdir(join(root, "rules"), { recursive: true });
  await writeFile(join(root, "rules", "r1.md"), "rule\n");
  dbState.rows = [{ id: "inst-1", installedPath: root, manifest }];
}

describe("getStudioPackageBom enrichment (M36 T1.2)", () => {
  it("enriches every kind from disk; the agent carries NO runner; rules are inventoried", async () => {
    await seedPackage();

    const bom = await getStudioPackageBom("inst-1");

    expect(bom).not.toBeNull();
    if (!bom) throw new Error("unexpected null bom");

    // Flows — compiled node/gate counts (2 steps → 2 nodes, no gates).
    expect(bom.flows).toEqual([
      { id: "dev", nodeCount: 2, gateCount: 0, engine: null },
    ]);

    // Skills — SKILL.md + references/a.md ⇒ 2 files, 1 subfolder.
    expect(bom.skills).toEqual([{ id: "s1", fileCount: 2, subfolderCount: 1 }]);

    // Platform-agents — from maister-agents/, routing metadata only; the runner
    // is NEVER projected (design §5.5).
    expect(bom.platformAgents).toHaveLength(1);
    expect(bom.platformAgents[0]).toMatchObject({
      id: "p1",
      description: "A platform agent",
      triggers: ["manual"],
      riskTier: "read_only",
      workspace: "none",
    });
    expect("runner" in bom.platformAgents[0]).toBe(false);

    // Subagents — capability agents (here agents/a1.md): lenient id +
    // description only, NEVER strict-parsed (Claude-subagent format).
    expect(bom.subagents).toEqual([{ id: "a1", description: "An agent" }]);

    // Rules — inventoried from disk (was permanently [] before M36).
    expect(bom.rules).toEqual([{ id: "r1.md", path: "rules/r1.md" }]);

    expect(bom.mcps).toEqual([]);
  });

  it("returns null for an unknown install", async () => {
    dbState.rows = [];

    expect(await getStudioPackageBom("missing")).toBeNull();
  });

  it("degrades a missing bundle to id-only members without throwing", async () => {
    dbState.rows = [
      {
        id: "inst-2",
        installedPath: join(root, "does-not-exist"),
        manifest,
      },
    ];

    const bom = await getStudioPackageBom("inst-2");

    if (!bom) throw new Error("unexpected null bom");

    expect(bom.flows).toEqual([
      { id: "dev", nodeCount: 0, gateCount: 0, engine: null },
    ]);
    expect(bom.skills).toEqual([{ id: "s1", fileCount: 0, subfolderCount: 0 }]);
    expect(bom.platformAgents).toEqual([
      { id: "p1", description: "", triggers: [], riskTier: "", workspace: "" },
    ]);
    expect(bom.subagents).toEqual([{ id: "a1", description: "" }]);
    expect(bom.rules).toEqual([]);
  });
});
