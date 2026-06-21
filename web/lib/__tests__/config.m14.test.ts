/**
 * T1.3 — validateNodeSettings carve-b: capability ref validation (M14)
 *
 * Tests:
 *  - unknown mcp ref → CONFIG
 *  - unknown skill ref → CONFIG
 *  - unknown restriction ref → CONFIG
 *  - unknown settingsProfile ref → CONFIG
 *  - all-known refs → pass
 *  - undefined capabilityRefIds → no ref check (back-compat)
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { loadFlowManifest } from "@/lib/config";
import { isMaisterError } from "@/lib/errors";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "config-m14-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeFixture(name: string, content: string): Promise<string> {
  const path = join(workDir, name);

  await writeFile(path, content, "utf8");

  return path;
}

type GraphManifest = {
  schemaVersion: number;
  name: string;
  compat: { engine_min: string };
  nodes: Array<Record<string, unknown>>;
};

function baseGraphManifest(): GraphManifest {
  return {
    schemaVersion: 1,
    name: "aif",
    compat: { engine_min: "1.1.0" },
    nodes: [
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "/aif-implement {{ task.prompt }}" },
        transitions: { success: "checks" },
      },
      {
        id: "checks",
        type: "check",
        action: { command: "pnpm test" },
        transitions: { success: "review" },
      },
      {
        id: "review",
        type: "human",
        finish: { human: { decisions: ["approve", "rework"] } },
        transitions: { approve: "done", rework: "implement" },
        rework: {
          allowedTargets: ["implement"],
          workspacePolicies: ["keep"],
          maxLoops: 3,
        },
      },
    ],
  };
}

async function writeGraph(
  name: string,
  mutate: (m: GraphManifest) => void = () => {},
): Promise<string> {
  const m = structuredClone(baseGraphManifest());

  mutate(m);

  return writeFixture(name, stringifyYaml(m));
}

type CapabilityRefIds = {
  mcp?: string[];
  skill?: string[];
  restriction?: string[];
  setting?: string[];
};

async function expectCapabilityRefError(
  path: string,
  capabilityRefIds: CapabilityRefIds,
): Promise<void> {
  let caught: unknown;

  try {
    await loadFlowManifest(path, { capabilityRefIds });
  } catch (e) {
    caught = e;
  }

  expect(isMaisterError(caught)).toBe(true);
  expect((caught as { code: string }).code).toBe("CONFIG");
}

describe("loadFlowManifest — capability ref validation (M14 T1.3)", () => {
  it("unknown mcp ref → CONFIG when capabilityRefIds is provided", async () => {
    const path = await writeGraph("graph-unknown-mcp.yaml", (m) => {
      m.nodes[0].settings = { mcps: ["github"] };
    });

    await expectCapabilityRefError(path, {
      mcp: ["postgres"], // "github" absent
      skill: [],
      restriction: [],
      setting: [],
    });
  });

  it("unknown skill ref → CONFIG when capabilityRefIds is provided", async () => {
    const path = await writeGraph("graph-unknown-skill.yaml", (m) => {
      m.nodes[0].settings = { skills: ["aif-implement"] };
    });

    await expectCapabilityRefError(path, {
      mcp: [],
      skill: ["some-other-skill"], // "aif-implement" absent
      restriction: [],
      setting: [],
    });
  });

  it("unknown restriction ref → CONFIG when capabilityRefIds is provided", async () => {
    const path = await writeGraph("graph-unknown-restriction.yaml", (m) => {
      m.nodes[0].settings = { restrictions: ["no-global-installs"] };
    });

    await expectCapabilityRefError(path, {
      mcp: [],
      skill: [],
      restriction: ["no-npm"], // "no-global-installs" absent
      setting: [],
    });
  });

  it("unknown settingsProfile ref → CONFIG when capabilityRefIds is provided", async () => {
    const path = await writeGraph("graph-unknown-profile.yaml", (m) => {
      m.nodes[0].settings = { settingsProfile: "codex-profile" };
    });

    await expectCapabilityRefError(path, {
      mcp: [],
      skill: [],
      restriction: [],
      setting: ["claude-profile"], // "codex-profile" absent
    });
  });

  it("all-known refs → manifest loads without error", async () => {
    const path = await writeGraph("graph-known-refs.yaml", (m) => {
      m.nodes[0].settings = {
        mcps: ["github"],
        skills: ["aif-implement"],
        restrictions: ["no-global-installs"],
        settingsProfile: "my-profile",
      };
    });

    await expect(
      loadFlowManifest(path, {
        capabilityRefIds: {
          mcp: ["github", "postgres"],
          skill: ["aif-implement", "aif-review"],
          restriction: ["no-global-installs"],
          setting: ["my-profile", "default"],
        },
      }),
    ).resolves.toBeTruthy();
  });

  it("undefined capabilityRefIds → no capability ref check (back-compat)", async () => {
    // When no capabilityRefIds is supplied, refs are NOT checked — existing
    // install-time callers and tests with no project context must stay green.
    const path = await writeGraph("graph-no-ref-check.yaml", (m) => {
      m.nodes[0].settings = {
        mcps: ["ghost-mcp"],
        skills: ["ghost-skill"],
        restrictions: ["ghost-restriction"],
        settingsProfile: "ghost-profile",
      };
    });

    await expect(loadFlowManifest(path)).resolves.toBeTruthy();
  });

  it("empty capabilityRefIds maps → unknown ref is still rejected", async () => {
    const path = await writeGraph("graph-empty-ref-maps.yaml", (m) => {
      m.nodes[0].settings = { mcps: ["github"] };
    });

    await expectCapabilityRefError(path, {
      mcp: [], // empty → "github" not in it
      skill: [],
      restriction: [],
      setting: [],
    });
  });

  it("judge node — unknown skills ref → CONFIG (exercises judge branch 919-948)", async () => {
    // Build a manifest with a judge-typed node that references an unknown skill.
    // Judge nodes have no settingsProfile — only mcps/skills/restrictions.
    const path = await writeGraph("graph-judge-unknown-skill.yaml", (m) => {
      m.nodes.push({
        id: "judge-quality",
        type: "judge",
        action: { prompt: "Assess code quality." },
        settings: { skills: ["aif-judge-skill"] },
        transitions: { pass: "done" },
      });
      m.nodes[1].transitions = { success: "judge-quality" };
    });

    await expectCapabilityRefError(path, {
      mcp: [],
      skill: [], // "aif-judge-skill" absent → must throw CONFIG
      restriction: [],
      setting: [],
    });
  });

  it("judge node — all-known refs → manifest loads without error", async () => {
    const path = await writeGraph("graph-judge-known-refs.yaml", (m) => {
      m.nodes.push({
        id: "judge-quality",
        type: "judge",
        action: { prompt: "Assess code quality." },
        settings: { skills: ["aif-judge-skill"], mcps: ["github"] },
        transitions: { pass: "done" },
      });
      m.nodes[1].transitions = { success: "judge-quality" };
    });

    await expect(
      loadFlowManifest(path, {
        capabilityRefIds: {
          mcp: ["github"],
          skill: ["aif-judge-skill"],
          restriction: [],
          setting: [],
        },
      }),
    ).resolves.toBeTruthy();
  });

  // H-1 (M37, ADR-098): an orchestrator inherits the ai_coding capability shape,
  // so its refs MUST be validated at manifest load exactly like ai_coding. Before
  // the fix, validateNodeSettings + firstUnknownCapabilityRef gated on
  // `ai_coding || judge` only, so an orchestrator's mcps/skills/settingsProfile
  // were never checked (and the strict-enforcement refusal was dead code).
  it("orchestrator node — unknown mcp ref → CONFIG (orchestrator cap-ref gate)", async () => {
    const path = await writeGraph("graph-orch-unknown-mcp.yaml", (m) => {
      m.compat.engine_min = "1.6.0"; // orchestrator floor
      m.nodes.push({
        id: "coordinate",
        type: "orchestrator",
        action: { prompt: "Decompose and delegate." },
        settings: { mcps: ["github"] },
        transitions: { success: "done" },
      });
      m.nodes[1].transitions = { success: "coordinate" };
    });

    await expectCapabilityRefError(path, {
      mcp: [], // "github" absent → must throw CONFIG via the orchestrator arm
      skill: [],
      restriction: [],
      setting: [],
    });
  });

  it("orchestrator node — unknown settingsProfile ref → CONFIG (ai_coding settingsProfile check inherited)", async () => {
    const path = await writeGraph("graph-orch-unknown-profile.yaml", (m) => {
      m.compat.engine_min = "1.6.0";
      m.nodes.push({
        id: "coordinate",
        type: "orchestrator",
        action: { prompt: "Decompose and delegate." },
        settings: { settingsProfile: "ghost-profile" },
        transitions: { success: "done" },
      });
      m.nodes[1].transitions = { success: "coordinate" };
    });

    // settingsProfile is checked only for ai_coding/orchestrator (not judge) —
    // this exercises the orchestrator arm of that branch specifically.
    await expectCapabilityRefError(path, {
      mcp: [],
      skill: [],
      restriction: [],
      setting: ["claude-profile"], // "ghost-profile" absent → CONFIG
    });
  });

  it("error message names the node id, the kind, and the ref", async () => {
    const path = await writeGraph("graph-named-error.yaml", (m) => {
      m.nodes[0].settings = { mcps: ["ghost-mcp"] };
    });

    let caught: unknown;

    try {
      await loadFlowManifest(path, {
        capabilityRefIds: {
          mcp: [],
          skill: [],
          restriction: [],
          setting: [],
        },
      });
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    const msg = caught instanceof Error ? caught.message : "";

    expect(msg).toContain("implement"); // node id
    expect(msg).toContain("mcp"); // capability kind
    expect(msg).toContain("ghost-mcp"); // offending ref
  });
});
