import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import {
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
  default_runner: claude-code
flows:
  - id: bugfix
    source: github.com/x/y
    version: v1.0.0
    runner: claude-code
  - id: feature
    source: github.com/x/z
    version: v0.1.0
`;

describe("loadProjectConfig", () => {
  it("loads a golden v2 manifest", async () => {
    const path = await writeFixture("maister.yaml", goldenYaml);
    const cfg = await loadProjectConfig(path);

    expect(cfg.project.name).toBe("myapp");
    expect(cfg.project.default_runner).toBe("claude-code");
    expect(cfg.flows).toHaveLength(2);
    expect(cfg.capabilities.mcps).toEqual([]);
    expect(cfg.flow_roles).toEqual([]);
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

  it("rejects legacy default_executor", async () => {
    const path = await writeFixture(
      "bad-default.yaml",
      `${goldenYaml}default_executor: claude-sonnet\n`,
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

  it("rejects legacy executor_override on a flow", async () => {
    const path = await writeFixture(
      "bad-override.yaml",
      goldenYaml.replace(
        "    version: v0.1.0",
        "    version: v0.1.0\n    executor_override: claude-ccr",
      ),
    );

    await expect(loadProjectConfig(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("rejects legacy executors[]", async () => {
    const path = await writeFixture(
      "legacy-executors.yaml",
      `${goldenYaml}executors:\n  - id: claude-sonnet\n    agent: claude\n    model: claude-sonnet-4-6\n`,
    );

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

  it("loads capability groups and rejects duplicate ids inside a kind", async () => {
    const yaml = `${goldenYaml}
capabilities:
  mcps:
    - id: github
      command: github-mcp-server
    - id: github
      command: github-mcp-server
`;
    const path = await writeFixture("dup-capability.yaml", yaml);

    await expect(loadProjectConfig(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("loads flow role registry entries", async () => {
    const yaml = `${goldenYaml}
flow_roles:
  - ref: reviewer
    label: Reviewer
    description: Human or service reviewer
  - ref: qa
`;
    const path = await writeFixture("roles.yaml", yaml);

    const cfg = await loadProjectConfig(path);

    expect(cfg.flow_roles).toEqual([
      {
        ref: "reviewer",
        label: "Reviewer",
        description: "Human or service reviewer",
      },
      { ref: "qa" },
    ]);
  });

  it("rejects duplicate flow role refs", async () => {
    const yaml = `${goldenYaml}
flow_roles:
  - ref: reviewer
  - ref: reviewer
`;
    const path = await writeFixture("dup-roles.yaml", yaml);

    await expect(loadProjectConfig(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });
});

const goldenFlowYaml = `
schemaVersion: 1
name: Bugfix
runner_profiles:
  claude-code:
    capability_agent: claude
    adapter: claude
    model: claude-sonnet-4-6
    provider:
      kind: anthropic
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

  it("rejects legacy recommended_executor", async () => {
    const path = await writeFixture(
      "legacy-recommended.yaml",
      `${goldenFlowYaml}recommended_executor: claude-sonnet\n`,
    );

    await expect(loadFlowManifest(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
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

  // M36 (ADR-095): the orchestrator node debuts at engine floor 1.6.0.
  it("rejects an orchestrator node when engine_min < 1.6.0", async () => {
    const path = await writeGraph("graph-orchestrator-old-engine.yaml", (m) => {
      m.compat.engine_min = "1.5.0";
      m.nodes[0] = {
        id: "implement",
        type: "orchestrator",
        action: { prompt: "coordinate {{ task.prompt }}" },
        transitions: { success: "checks" },
      };
    });

    await expect(loadFlowManifest(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
  });

  it("accepts an orchestrator node at engine_min >= 1.6.0", async () => {
    const path = await writeGraph("graph-orchestrator-ok.yaml", (m) => {
      m.compat.engine_min = "1.6.0";
      m.nodes[0] = {
        id: "implement",
        type: "orchestrator",
        action: { prompt: "coordinate {{ task.prompt }}" },
        settings: { delegation: { max_fanout: 8 } },
        transitions: { success: "checks" },
      };
    });

    const manifest = await loadFlowManifest(path);

    expect(manifest.nodes?.[0].type).toBe("orchestrator");
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
      // Only steps.* refs — no bare artifact ids so engine_min 1.1.0 is fine.
      m.nodes[1].input = {
        requires: ["steps.implement.output"],
      };
    });

    await expect(loadFlowManifest(path)).resolves.toBeTruthy();
  });

  // M11c: settings is now a TYPED parsed shape (was an opaque passthrough in
  // M11a). loadFlowManifest returns the typed node settings, not a raw record.
  it("returns a typed parsed node settings block", async () => {
    const path = await writeGraph("graph-settings.yaml", (m) => {
      m.nodes[0].settings = { mcps: ["github"], permissionMode: "ask" };
    });
    const manifest = await loadFlowManifest(path);
    const node = manifest.nodes?.[0] as { settings?: Record<string, unknown> };

    expect(node.settings).toMatchObject({
      mcps: ["github"],
      permissionMode: "ask",
    });
  });

  // P14: the SETTINGS_NOT_ENFORCED_WARN named symbol MUST be gone in M11c, and
  // no "parsed but not enforced" warning may be emitted when loading a graph
  // manifest that carries settings. We assert BOTH:
  //  (a) the named export is removed from the @/lib/config module namespace, and
  //  (b) no log line containing the sentinel substring is emitted on load.
  // (a) is the non-brittle named-symbol-removed assertion; (b) is the
  // behavioral guard. Pino is constructed module-internally, so (b) captures
  // process.stdout writes for the duration of the load.
  it("no longer exports SETTINGS_NOT_ENFORCED_WARN (P14, symbol removed)", async () => {
    const mod = (await import("@/lib/config")) as Record<string, unknown>;

    expect(mod.SETTINGS_NOT_ENFORCED_WARN).toBeUndefined();
  });

  it("emits no 'parsed but not enforced' warning when loading settings", async () => {
    const path = await writeGraph("graph-settings-nowarn.yaml", (m) => {
      m.nodes[0].settings = { mcps: ["github"], permissionMode: "ask" };
    });

    const captured: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);

    // FIXME(any): patching process.stdout.write for the duration of the load
    // to capture pino's module-internal logger output (no injectable logger
    // seam on loadFlowManifest).
    (process.stdout as { write: unknown }).write = ((
      chunk: unknown,
      ...rest: unknown[]
    ) => {
      captured.push(String(chunk));

      return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;

    try {
      await loadFlowManifest(path);
    } finally {
      (process.stdout as { write: unknown }).write = orig;
    }

    expect(captured.join("")).not.toContain("parsed but not enforced");
  });
});

// --- M11c task 1.6: node-level settings validation -------------------------
// loadFlowManifest / validateGraphManifest reject settings invariants that zod
// shape-validation cannot express. Each rejection MUST be MaisterError("CONFIG")
// and SHOULD name the offending node id + field (asserted on code, not message
// substring, per the skill-context named-code rule).
//
async function expectGraphConfigError(path: string): Promise<void> {
  let caught: unknown;

  try {
    await loadFlowManifest(path);
  } catch (e) {
    caught = e;
  }

  expect(isMaisterError(caught)).toBe(true);
  expect((caught as { code: string }).code).toBe("CONFIG");
}

describe("loadFlowManifest — node settings validation (M11c)", () => {
  it("rejects legacy settings.executors", async () => {
    const path = await writeGraph("graph-legacy-executor-ref.yaml", (m) => {
      m.nodes[0].settings = { executors: ["ghost-executor"] };
    });

    await expectGraphConfigError(path);
  });

  it("accepts settings.runner as a portable ACP runner target", async () => {
    const path = await writeGraph("graph-good-runner-target.yaml", (m) => {
      m.nodes[0].settings = { runner: "claude-code" };
    });

    await expect(loadFlowManifest(path)).resolves.toBeTruthy();
  });

  it("rejects a human decision listed in settings.decisions but absent from transitions", async () => {
    // The human node's settings.decisions[] must each map to a declared
    // transition key (same invariant as finish.human.decisions, applied to the
    // typed human settings shape).
    const path = await writeGraph("graph-bad-decision.yaml", (m) => {
      m.nodes[2].settings = { decisions: ["approve", "escalate"] };
      // transitions only declare approve + rework; "escalate" is undeclared.
    });

    await expectGraphConfigError(path);
  });

  it("rejects an out-of-range limits.maxDurationMinutes via node validation", async () => {
    // zod already rejects <= 0 at the schema level; this asserts the manifest
    // loader surfaces it as CONFIG (not an uncaught ZodError) end-to-end.
    const path = await writeGraph("graph-bad-limit.yaml", (m) => {
      m.nodes[0].settings = { limits: { maxDurationMinutes: 0 } };
    });

    await expectGraphConfigError(path);
  });

  it("rejects an enforcement key on a cli node (no such capability class)", async () => {
    const path = await writeGraph("graph-enforcement-on-cli.yaml", (m) => {
      m.nodes[1].settings = { enforcement: { mcps: "strict" } };
    });

    await expectGraphConfigError(path);
  });

  it("accepts a graph with valid typed settings and no executor set supplied", async () => {
    // When the caller omits the executor set (install-time loadManifestOrThrow),
    // shape + graph validation still pass; only the executor cross-ref is
    // skipped.
    const path = await writeGraph("graph-settings-ok.yaml", (m) => {
      m.nodes[0].settings = {
        mcps: ["github"],
        thinkingEffort: "high",
        enforcement: { mcps: "instruct" },
      };
    });

    await expect(loadFlowManifest(path)).resolves.toBeTruthy();
  });

  it("rejects human role refs absent from the supplied project Flow role set", async () => {
    const path = await writeGraph("graph-bad-role-ref.yaml", (m) => {
      m.nodes[2].finish = {
        human: { role: "reviewer", decisions: ["approve", "rework"] },
      };
      m.nodes[2].settings = { roles: ["qa"] };
    });

    let caught: unknown;

    try {
      await loadFlowManifest(path, { roleRefs: ["release-manager"] });
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    const msg = caught instanceof Error ? caught.message : "";

    expect(msg).toContain("review");
    expect(msg).toContain("reviewer");
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
