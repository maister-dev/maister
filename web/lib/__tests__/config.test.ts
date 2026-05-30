import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import {
  SETTINGS_NOT_ENFORCED_WARN,
  loadFlowManifest,
  loadProjectConfig,
  validateFormSchemaVersion,
} from "@/lib/config";
import { isMaisterError } from "@/lib/errors";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "config-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeFixture(name: string, content: string): Promise<string> {
  const path = join(workDir, name);

  await writeFile(path, content, "utf8");

  return path;
}

const goldenYaml = `
schemaVersion: 2
project:
  name: myapp
  repo_path: /repos/myapp
  main_branch: main
  branch_prefix: maister/
executors:
  - id: claude-sonnet
    agent: claude
    model: claude-sonnet-4-6
  - id: claude-glm
    agent: claude
    model: glm-4.6
    env:
      ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic
      ANTHROPIC_AUTH_TOKEN: fake
  - id: claude-ccr
    agent: claude
    model: glm-4.6
    router: ccr
default_executor: claude-sonnet
flows:
  - id: bugfix
    source: github.com/x/y
    version: v1.0.0
  - id: feature
    source: github.com/x/z
    version: v0.1.0
    executor_override: claude-ccr
`;

describe("loadProjectConfig", () => {
  it("loads a golden v2 manifest", async () => {
    const path = await writeFixture("maister.yaml", goldenYaml);
    const cfg = await loadProjectConfig(path);

    expect(cfg.project.name).toBe("myapp");
    expect(cfg.executors).toHaveLength(3);
    expect(cfg.flows).toHaveLength(2);
  });

  it("rejects missing file with CONFIG MaisterError", async () => {
    const path = join(workDir, "does-not-exist.yaml");

    await expect(loadProjectConfig(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("rejects invalid YAML", async () => {
    const path = await writeFixture("bad.yaml", "key: [unclosed");

    await expect(loadProjectConfig(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("rejects wrong schemaVersion", async () => {
    const path = await writeFixture(
      "v1.yaml",
      goldenYaml.replace("schemaVersion: 2", "schemaVersion: 1"),
    );

    await expect(loadProjectConfig(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("rejects unknown default_executor", async () => {
    const path = await writeFixture(
      "bad-default.yaml",
      goldenYaml.replace(
        "default_executor: claude-sonnet",
        "default_executor: nonexistent",
      ),
    );

    let caught: unknown;

    try {
      await loadProjectConfig(path);
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect(caught instanceof Error ? caught.message : "").toContain(
      "default_executor",
    );
  });

  it("rejects unknown executor_override on a flow", async () => {
    const path = await writeFixture(
      "bad-override.yaml",
      goldenYaml.replace(
        "executor_override: claude-ccr",
        "executor_override: missing",
      ),
    );

    await expect(loadProjectConfig(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("rejects duplicate executor IDs", async () => {
    const dup = goldenYaml.replace(
      "  - id: claude-glm\n    agent: claude\n    model: glm-4.6",
      "  - id: claude-sonnet\n    agent: claude\n    model: glm-4.6",
    );
    const path = await writeFixture("dup.yaml", dup);

    await expect(loadProjectConfig(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("rejects duplicate flow IDs", async () => {
    const dup = goldenYaml.replace(
      "  - id: feature\n    source: github.com/x/z\n    version: v0.1.0",
      "  - id: bugfix\n    source: github.com/x/z\n    version: v0.1.0",
    );
    const path = await writeFixture("dup-flow.yaml", dup);

    await expect(loadProjectConfig(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });
});

const goldenFlowYaml = `
schemaVersion: 1
name: Bugfix
recommended_executor: claude-sonnet
steps:
  - id: plan
    type: agent
    mode: new-session
    prompt: "/aif-plan {{ task.prompt }}"
  - id: lint
    type: cli
    command: pnpm lint
  - id: review
    type: human
    form_schema: ./schemas/review.json
    on_reject:
      goto_step: plan
      comments_var: comments
`;

describe("loadFlowManifest", () => {
  it("loads a golden flow.yaml with all step types", async () => {
    const path = await writeFixture("flow.yaml", goldenFlowYaml);
    const manifest = await loadFlowManifest(path);

    expect(manifest.name).toBe("Bugfix");
    expect(manifest.steps).toHaveLength(3);
  });

  it("rejects on_reject.goto_step referencing missing step", async () => {
    const bad = goldenFlowYaml.replace("goto_step: plan", "goto_step: missing");
    const path = await writeFixture("bad-goto.yaml", bad);

    await expect(loadFlowManifest(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("rejects duplicate step IDs", async () => {
    const dup = goldenFlowYaml.replace(
      "  - id: lint\n    type: cli",
      "  - id: plan\n    type: cli",
    );
    const path = await writeFixture("dup-step.yaml", dup);

    await expect(loadFlowManifest(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("rejects flow with unbalanced Mustache prompt template", async () => {
    const bad = goldenFlowYaml.replace(
      'prompt: "/aif-plan {{ task.prompt }}"',
      'prompt: "/aif-plan {{ task.prompt"',
    );
    const path = await writeFixture("bad-template.yaml", bad);

    let caught: unknown;

    try {
      await loadFlowManifest(path);
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("CONFIG");
    const msg = caught instanceof Error ? caught.message : "";

    expect(msg).toMatch(/invalid mustache template/);
    expect(msg).toContain("plan");
  });
});

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
        pre_finish: {
          gates: [
            {
              id: "test",
              kind: "command_check",
              mode: "blocking",
              command: "pnpm test",
            },
          ],
        },
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
          commentsVar: "review_comments",
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

describe("loadFlowManifest — graph (nodes[])", () => {
  it("loads a valid graph manifest", async () => {
    const manifest = await loadFlowManifest(await writeGraph("graph.yaml"));

    expect(manifest.name).toBe("aif");
    expect(manifest.nodes).toHaveLength(3);
    expect(manifest.steps).toBeUndefined();
  });

  it("rejects a graph flow that does not declare engine_min >= 1.1.0", async () => {
    const path = await writeGraph("graph-old-engine.yaml", (m) => {
      m.compat.engine_min = "1.0.0";
    });

    await expect(loadFlowManifest(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("rejects an unknown node id in a transition", async () => {
    const path = await writeGraph("graph-unknown-target.yaml", (m) => {
      (m.nodes[0].transitions as Record<string, string>).success = "ghost";
    });

    await expect(loadFlowManifest(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("rejects a human decision with no declared transition", async () => {
    const path = await writeGraph("graph-undeclared-decision.yaml", (m) => {
      m.nodes[2].transitions = { approve: "done" }; // drop rework transition
    });

    await expect(loadFlowManifest(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("rejects a cycle with no bounding rework.maxLoops", async () => {
    const path = await writeGraph("graph-unbounded-cycle.yaml", (m) => {
      delete m.nodes[2].rework; // review->implement back-edge now unbounded
    });

    await expect(loadFlowManifest(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("rejects duplicate node ids", async () => {
    const path = await writeGraph("graph-dup-node.yaml", (m) => {
      m.nodes.push({ ...m.nodes[0] });
    });

    await expect(loadFlowManifest(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("rejects duplicate gate ids across nodes", async () => {
    const path = await writeGraph("graph-dup-gate.yaml", (m) => {
      m.nodes[2].pre_finish = {
        gates: [
          {
            id: "test",
            kind: "command_check",
            mode: "blocking",
            command: "echo hi",
          },
        ],
      };
    });

    await expect(loadFlowManifest(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("rejects a node id reserved as the terminal target ('done')", async () => {
    const path = await writeGraph("graph-done-node.yaml", (m) => {
      m.nodes[0].id = "done";
    });

    await expect(loadFlowManifest(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("rejects a human decision that only matches an inherited prototype key", async () => {
    // "toString" is `in` Object.prototype but is NOT an own transition key —
    // must still be rejected (Object.hasOwn, not `in`).
    const path = await writeGraph("graph-proto-decision.yaml", (m) => {
      (
        m.nodes[2].finish as { human: { decisions: string[] } }
      ).human.decisions = ["approve", "toString"];
    });

    await expect(loadFlowManifest(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("rejects an unknown node id in input.requires (steps.<id> form)", async () => {
    const path = await writeGraph("graph-requires-ghost.yaml", (m) => {
      m.nodes[0].input = { requires: ["steps.ghost.output"] };
    });

    await expect(loadFlowManifest(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("accepts a known node id in input.requires (steps.<id> form)", async () => {
    const path = await writeGraph("graph-requires-known.yaml", (m) => {
      m.nodes[1].input = {
        requires: ["steps.implement.output", "some-artifact"],
      };
    });

    await expect(loadFlowManifest(path)).resolves.toBeTruthy();
  });

  it("preserves an opaque node settings block (no silent strip)", async () => {
    const path = await writeGraph("graph-settings.yaml", (m) => {
      m.nodes[0].settings = { mcps: ["github"], permissionMode: "ask" };
    });
    const manifest = await loadFlowManifest(path);
    const node = manifest.nodes?.[0] as { settings?: Record<string, unknown> };

    expect(node.settings).toEqual({ mcps: ["github"], permissionMode: "ask" });
  });

  it("exposes SETTINGS_NOT_ENFORCED_WARN as a named constant (P14)", () => {
    expect(SETTINGS_NOT_ENFORCED_WARN).toBe(
      "[flow] node settings parsed but not enforced until M11c",
    );
  });
});

describe("validateFormSchemaVersion", () => {
  it("returns successfully when versions match", () => {
    expect(() =>
      validateFormSchemaVersion({ schemaVersion: 1, fields: [] }, 1),
    ).not.toThrow();
  });

  it("throws CONFIG with both versions named when mismatched", () => {
    let caught: unknown;

    try {
      validateFormSchemaVersion({ schemaVersion: 2, fields: [] }, 1);
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    const msg = caught instanceof Error ? caught.message : "";

    expect(msg).toContain("1");
    expect(msg).toContain("2");
  });

  it("throws CONFIG on malformed input", () => {
    expect(() => validateFormSchemaVersion({ fields: [] }, 1)).toThrow();
    expect(() => validateFormSchemaVersion(null, 1)).toThrow();
  });
});
