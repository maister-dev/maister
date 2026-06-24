import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { loadFlowManifest } from "@/lib/config";
import { flowYamlV1Schema } from "@/lib/config.schema";
import { isMaisterError } from "@/lib/errors";

let workDir: string;
let originalFanout: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "config-consensus-test-"));
  originalFanout = process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT;
});

afterEach(async () => {
  if (originalFanout === undefined) {
    delete process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT;
  } else {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = originalFanout;
  }
  await rm(workDir, { recursive: true, force: true });
});

type GraphManifest = {
  schemaVersion: number;
  name: string;
  compat: { engine_min: string };
  nodes: Array<Record<string, unknown>>;
  steps?: Array<Record<string, unknown>>;
};

function consensusNode(): Record<string, unknown> {
  return {
    id: "decide_release_plan",
    type: "consensus",
    prompt: "Produce a release plan for {{ task.prompt }}.",
    participants: [
      { id: "architect", agent: "architecture-reviewer" },
      { id: "implementer", runner: "codex" },
      { id: "qa", agent: "qa-reviewer" },
    ],
    workspace: { mode: "repo_read" },
    material_axes: [
      "scope_matches_milestone",
      "migration_order_is_safe",
      "human_handoff_is_clear",
    ],
    rounds: { mode: "iterate", max: 3 },
    on_no_consensus: "escalate",
    synthesizer: { agent: "plan-synthesizer" },
    output: {
      produces: [
        { id: "consensus_plan", kind: "plan", current: true },
        { id: "debate_log", kind: "human_note", current: true },
      ],
    },
    transitions: { success: "implement" },
  };
}

function implementNode(): Record<string, unknown> {
  return {
    id: "implement",
    type: "ai_coding",
    action: { prompt: "/aif-implement {{ task.prompt }}" },
    transitions: { success: "done" },
  };
}

function baseManifest(): GraphManifest {
  return {
    schemaVersion: 1,
    name: "consensus-flow",
    compat: { engine_min: "1.9.0" },
    nodes: [consensusNode(), implementNode()],
  };
}

async function writeGraph(
  name: string,
  mutate: (manifest: GraphManifest) => void = () => {},
): Promise<string> {
  const manifest = structuredClone(baseManifest());

  mutate(manifest);
  const path = join(workDir, name);

  await writeFile(path, stringifyYaml(manifest), "utf8");

  return path;
}

async function expectConfigError(
  path: string,
  ...messageParts: readonly string[]
): Promise<void> {
  let caught: unknown;

  try {
    await loadFlowManifest(path);
  } catch (error) {
    caught = error;
  }

  expect(isMaisterError(caught)).toBe(true);
  expect((caught as { code: string }).code).toBe("CONFIG");
  const message = caught instanceof Error ? caught.message : "";

  for (const part of messageParts) {
    expect(message).toContain(part);
  }
}

function consensusRecord(manifest: GraphManifest): Record<string, unknown> {
  return manifest.nodes[0];
}

describe("loadFlowManifest — consensus node validation (M41)", () => {
  it("accepts a valid consensus node at engine_min 1.9.0", async () => {
    const manifest = await loadFlowManifest(await writeGraph("valid.yaml"));
    const node = manifest.nodes?.[0];

    expect(node?.type).toBe("consensus");
    if (node?.type !== "consensus") throw new Error("expected consensus node");
    expect(node.participants).toHaveLength(3);
    expect(node.rounds).toEqual({ mode: "iterate", max: 3 });
    expect(node.output?.produces?.map((entry) => entry.kind)).toEqual([
      "plan",
      "human_note",
    ]);
  });

  it("rejects consensus when engine_min is below 1.9.0", async () => {
    const path = await writeGraph("old-engine.yaml", (manifest) => {
      manifest.compat.engine_min = "1.8.0";
    });

    await expectConfigError(path, "consensus", "1.9.0");
  });

  it("rejects fewer than two participants", async () => {
    const path = await writeGraph("one-participant.yaml", (manifest) => {
      consensusRecord(manifest).participants = [
        { id: "solo", runner: "codex" },
      ];
    });

    await expectConfigError(path, "participants");
  });

  it("rejects participants above MAISTER_MAX_ORCHESTRATOR_FANOUT", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "2";
    const path = await writeGraph("too-many-participants.yaml");

    await expectConfigError(path, "participants", "2");
  });

  it("rejects a participant that declares both agent and runner", async () => {
    const path = await writeGraph("mixed-participant-ref.yaml", (manifest) => {
      const node = consensusRecord(manifest);
      const participants = node.participants as Array<Record<string, unknown>>;

      participants[0] = {
        id: "ambiguous",
        agent: "architecture-reviewer",
        runner: "codex",
      };
    });

    await expectConfigError(path, "agent", "runner");
  });

  it("rejects empty material axes", async () => {
    const path = await writeGraph("empty-axes.yaml", (manifest) => {
      consensusRecord(manifest).material_axes = [];
    });

    await expectConfigError(path, "material_axes");
  });

  it("rejects a missing synthesizer", async () => {
    const path = await writeGraph("missing-synthesizer.yaml", (manifest) => {
      delete consensusRecord(manifest).synthesizer;
    });

    await expectConfigError(path, "synthesizer");
  });

  it("rejects rounds.max below one", async () => {
    const path = await writeGraph("bad-round-max.yaml", (manifest) => {
      consensusRecord(manifest).rounds = { mode: "iterate", max: 0 };
    });

    await expectConfigError(path, "rounds", "max");
  });

  it("rejects missing mandatory consensus outputs", async () => {
    const path = await writeGraph("missing-output.yaml", (manifest) => {
      consensusRecord(manifest).output = {
        produces: [{ id: "consensus_plan", kind: "plan", current: true }],
      };
    });

    await expectConfigError(path, "consensus_plan", "debate_log");
  });

  it("rejects consensus outputs with wrong mandatory kinds", async () => {
    const path = await writeGraph("wrong-output-kind.yaml", (manifest) => {
      consensusRecord(manifest).output = {
        produces: [
          { id: "consensus_plan", kind: "human_note", current: true },
          { id: "debate_log", kind: "human_note", current: true },
        ],
      };
    });

    await expectConfigError(path, "consensus_plan", "plan");
  });

  it("rejects extra consensus outputs beyond the two mandatory artifacts", async () => {
    const path = await writeGraph("extra-output.yaml", (manifest) => {
      consensusRecord(manifest).output = {
        produces: [
          { id: "consensus_plan", kind: "plan", current: true },
          { id: "debate_log", kind: "human_note", current: true },
          { id: "other", kind: "generic_file", current: true },
        ],
      };
    });

    await expectConfigError(path, "exactly", "consensus_plan", "debate_log");
  });
});

describe("flowYamlV1Schema — consensus keeps graph/steps exclusivity", () => {
  it("rejects a consensus graph that also declares legacy steps[]", () => {
    const manifest = baseManifest();

    manifest.steps = [
      {
        id: "legacy",
        type: "cli",
        command: "true",
      },
    ];

    expect(() => flowYamlV1Schema.parse(manifest)).toThrow(
      /exactly one of steps\[\] or nodes\[\]/,
    );
  });
});
