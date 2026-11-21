import type { FlowYamlV1 } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { flowYamlV1Schema } from "@/lib/config.schema";
import { validateGraphManifest } from "@/lib/config";
import { classifyStoredFlowManifest } from "@/lib/flows/manifest-parser";
import { compileManifest, resolveTransition } from "@/lib/flows/graph/compile";

it("C01/W02 rejects autonomous evidence declarations with missing sources or an old floor", () => {
  const manifest = {
    schemaVersion: 1,
    name: "Completion",
    compat: { engine_min: "3.15.0" },
    autonomous_completion: {
      ci: "ci",
      gates: [{ node: "verify", gate: "check" }],
      review: { node: "verify", gate: "judge" },
    },
    nodes: [
      {
        type: "cli",
        id: "verify",
        action: { command: "true" },
        transitions: { success: "publish" },
        pre_finish: {
          gates: [
            {
              id: "check",
              kind: "command_check",
              mode: "blocking",
              command: "true",
            },
            {
              id: "judge",
              kind: "ai_judgment",
              mode: "blocking",
              prompt: "Review the change",
            },
          ],
        },
      },
      { type: "publish", id: "publish", transitions: { success: "ci" } },
      {
        type: "wait",
        id: "ci",
        timeout: 60,
        on: {
          kind: "ci",
          publication: "publish",
          transport: "pull",
          checks: ["build"],
          issuer: "github-actions",
        },
        transitions: {
          success: "done",
          failure: "done",
          cancelled: "done",
          stale: "done",
          timeout: "done",
        },
      },
    ],
  };

  expect(classifyStoredFlowManifest(manifest)).toMatchObject({
    compatible: true,
  });
  const push = {
    ...manifest,
    nodes: manifest.nodes.map((node) =>
      node.id === "ci"
        ? {
            ...node,
            on: {
              ...node.on,
              transport: "push",
              name: "build",
              issuer: "token",
            },
          }
        : node,
    ),
  };
  const pushResult = flowYamlV1Schema.safeParse(push);

  expect(pushResult.success).toBe(false);
  if (!pushResult.success)
    expect(pushResult.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["autonomous_completion", "ci"],
          message: expect.stringContaining("provider_issuer"),
        }),
      ]),
    );
  expect(
    classifyStoredFlowManifest({
      ...push,
      autonomous_completion: undefined,
      compat: { engine_min: "3.14.0" },
      nodes: push.nodes.map((node) =>
        node.id === "ci"
          ? { ...node, on: { ...node.on, provider_issuer: "github-actions" } }
          : node,
      ),
    }),
  ).toMatchObject({
    compatible: false,
    reason: { kind: "engine_incompatible" },
  });
  expect(
    classifyStoredFlowManifest({
      ...manifest,
      compat: { engine_min: "3.14.0" },
    }),
  ).toMatchObject({
    compatible: false,
    reason: { kind: "engine_incompatible" },
  });
  expect(
    flowYamlV1Schema.safeParse({
      ...manifest,
      autonomous_completion: {
        ...manifest.autonomous_completion,
        ci: "missing",
      },
    }).success,
  ).toBe(false);
  expect(
    flowYamlV1Schema.safeParse({
      ...manifest,
      autonomous_completion: {
        ...manifest.autonomous_completion,
        review: { node: "verify", gate: "check" },
      },
    }).success,
  ).toBe(false);
});

const graph: FlowYamlV1 = {
  schemaVersion: 1,
  name: "aif",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement\n\n{{ c }}" },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      finish: { human: { decisions: ["approve", "rework"] } },
      transitions: { approve: "done", rework: "implement" },
      pre_finish: {
        gates: [
          { id: "g", kind: "command_check", mode: "blocking", command: "true" },
        ],
      },
      rework: {
        allowedTargets: ["implement"],
        workspacePolicies: ["keep"],
        maxLoops: 3,
        commentsVar: "c",
      },
    },
  ],
} as FlowYamlV1;

describe("compileManifest — graph nodes[]", () => {
  it("passes nodes through with transitions, gates, rework, finishHuman", () => {
    const g = compileManifest(graph);

    expect(g.entry).toBe("implement");

    const review = g.nodes.get("review")!;

    expect(review.source.kind).toBe("node");
    expect(review.transitions).toEqual({
      approve: "done",
      rework: "implement",
    });
    expect(review.gates).toHaveLength(1);
    expect(review.rework?.maxLoops).toBe(3);
    expect(review.finishHuman?.decisions).toEqual(["approve", "rework"]);
  });

  it("rejects a human rework target that does not render its feedback variable", () => {
    const invalid = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === "implement"
          ? { ...node, action: { prompt: "/aif-implement" } }
          : node,
      ),
    } as FlowYamlV1;

    expect(() => compileManifest(invalid)).toThrow(
      'human review node "review" rework target "implement" must render commentsVar "c" in action.prompt',
    );
  });

  it("accepts the default-expression form and refuses a missing feedback variable", () => {
    const guarded = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === "implement"
          ? { ...node, action: { prompt: "Fix: {{ c ?? '' }}" } }
          : node,
      ),
    } as FlowYamlV1;
    const missing = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === "review"
          ? {
              ...node,
              finish: { human: { decisions: ["approve", "rework"] } },
              rework: { ...node.rework, commentsVar: undefined },
            }
          : node,
      ),
    } as FlowYamlV1;

    expect(() => compileManifest(guarded)).not.toThrow();
    expect(() => compileManifest(missing)).toThrow(
      'human review node "review" needs a valid top-level commentsVar',
    );
  });

  it("rejects a dotted feedback key before a rework packet can be lost", () => {
    const invalid = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === "review"
          ? { ...node, rework: { ...node.rework, commentsVar: "review.notes" } }
          : node,
      ),
    } as FlowYamlV1;

    expect(() => compileManifest(invalid)).toThrow(
      'human review node "review" needs a valid top-level commentsVar',
    );
  });

  it("requires every rework target to be a renderer reading the exact variable", () => {
    const cliTarget = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === "implement"
          ? {
              id: "implement",
              type: "cli",
              action: { command: "echo {{ another_value }}" },
              transitions: { success: "review" },
            }
          : node,
      ),
    } as FlowYamlV1;

    expect(() => compileManifest(cliTarget)).toThrow(
      'human review node "review" rework target "implement" must render commentsVar "c" in action.command',
    );
  });

  // M11c task 3.0 — thread typed `settings` through CompiledNode so the
  // per-node runtime gate reads it without re-parsing the manifest.
  it("threads a node's typed `settings` onto the CompiledNode (ai_coding)", () => {
    const settingsGraph: FlowYamlV1 = {
      schemaVersion: 1,
      name: "aif",
      nodes: [
        {
          id: "implement",
          type: "ai_coding",
          action: { prompt: "/aif-implement" },
          transitions: { success: "done" },
          settings: {
            tools: { claude: ["Edit"] },
            enforcement: { mcps: "strict", tools: "instruct" },
          },
        },
      ],
    } as unknown as FlowYamlV1;

    const g = compileManifest(settingsGraph);
    const implement = g.nodes.get("implement")!;

    expect(implement.settings).toBeDefined();
    expect(implement.settings).toEqual({
      tools: { claude: ["Edit"] },
      enforcement: { mcps: "strict", tools: "instruct" },
    });
  });

  it("leaves CompiledNode.settings undefined for a node without settings", () => {
    const g = compileManifest(graph);

    // `implement` in the shared `graph` fixture carries no settings.
    expect(g.nodes.get("implement")!.settings).toBeUndefined();
  });

  it("maps a consensus graph node to nodeType consensus", () => {
    const consensusGraph: FlowYamlV1 = {
      schemaVersion: 1,
      name: "consensus",
      compat: { engine_min: "1.9.0" },
      nodes: [
        {
          id: "decide",
          type: "consensus",
          prompt: "Decide the release plan.",
          participants: [
            { id: "architect", agent: "architecture-reviewer" },
            { id: "implementer", runner: "codex" },
          ],
          material_axes: ["scope_matches_milestone"],
          synthesizer: { agent: "plan-synthesizer" },
          output: {
            produces: [
              { id: "consensus_plan", kind: "plan", current: true },
              { id: "debate_log", kind: "human_note", current: true },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    } as unknown as FlowYamlV1;

    const compiled = compileManifest(consensusGraph);

    expect(compiled.nodes.get("decide")?.nodeType).toBe("consensus");
  });

  it("resolveTransition resolves a decision and treats 'done' as terminal", () => {
    const g = compileManifest(graph);
    const review = g.nodes.get("review")!;

    expect(resolveTransition(review, "approve")).toBeNull(); // -> "done"
    expect(resolveTransition(review, "rework")).toBe("implement");
    expect(resolveTransition(review, "unknown-decision")).toBeNull();
  });
});

describe("compileManifest — session assignment (M42)", () => {
  it("assigns a runner-bearing node with no session to the default session", () => {
    const manifest = {
      schemaVersion: 1,
      name: "s",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "implement",
          type: "ai_coding",
          action: { prompt: "x" },
          transitions: { success: "done" },
        },
      ],
    } as FlowYamlV1;

    const g = compileManifest(manifest);

    expect(g.nodes.get("implement")?.session).toBe("default");
    expect([...g.sessions.keys()]).toEqual(["default"]);
  });

  it("assigns a node with `session:` to that named session with its declared runner", () => {
    const manifest = {
      schemaVersion: 1,
      name: "named",
      compat: { engine_min: "2.0.0" },
      sessions: { review: { runner: "claude-opus" } },
      nodes: [
        {
          id: "implement",
          type: "ai_coding",
          action: { prompt: "x" },
          transitions: { success: "rev" },
        },
        {
          id: "rev",
          type: "ai_coding",
          action: { prompt: "y" },
          session: "review",
          transitions: { success: "done" },
        },
      ],
    } as FlowYamlV1;

    const g = compileManifest(manifest);

    expect(g.nodes.get("implement")?.session).toBe("default");
    expect(g.nodes.get("rev")?.session).toBe("review");
    expect(g.sessions.get("review")?.runner).toBe("claude-opus");
    expect(new Set(g.sessions.keys())).toEqual(new Set(["default", "review"]));
  });

  it("gives a runner-bearing node with settings.runner and no session a solo session", () => {
    const manifest = {
      schemaVersion: 1,
      name: "solo",
      compat: { engine_min: "2.0.0" },
      nodes: [
        {
          id: "judge",
          type: "judge",
          action: { prompt: "j" },
          settings: { runner: { capability_agent: "claude", model: "m" } },
          transitions: { success: "done" },
        },
      ],
    } as unknown as FlowYamlV1;

    const g = compileManifest(manifest);

    expect(g.nodes.get("judge")?.session).toBe("judge");
    expect(g.sessions.get("judge")?.runner).toEqual({
      capability_agent: "claude",
      model: "m",
    });
  });

  it("does not assign a session to non-runner-bearing nodes", () => {
    const manifest = {
      schemaVersion: 1,
      name: "mixed",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "lint",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "done" },
        },
      ],
    } as FlowYamlV1;

    const g = compileManifest(manifest);

    expect(g.nodes.get("lint")?.session).toBeUndefined();
    expect(g.sessions.size).toBe(0);
  });
});

describe("ADR-215 wait graph contracts", () => {
  const withWait = (
    on: unknown,
    transitions: Record<string, string>,
    floor = "3.13.0",
  ) => {
    return flowYamlV1Schema.parse({
      schemaVersion: 1,
      name: "condition tests",
      compat: { engine_min: floor },
      nodes: [{ id: "wait", type: "wait", on, timeout: 120, transitions }],
    });
  };

  it.each([
    [{ kind: "timer", after: 60 }, ["elapsed", "timeout", "cancelled"]],
    [
      { kind: "comment", actor: { type: "user", id: "reviewer-1" } },
      ["commented", "timeout", "cancelled"],
    ],
    [
      { kind: "run", run_id: "run-child", relation: "child" },
      [
        "done",
        "failed",
        "review",
        "crashed",
        "abandoned",
        "timeout",
        "cancelled",
      ],
    ],
    [
      { kind: "signal", name: "build", outcomes: ["pass"], bind: "head_sha" },
      ["pass", "timeout", "cancelled", "stale"],
    ],
  ] as const)(
    "W02 compiles the complete outcome set for %j",
    (condition, outcomes) => {
      const manifest = withWait(
        condition,
        Object.fromEntries(outcomes.map((outcome) => [outcome, "done"])),
      );

      validateGraphManifest(manifest, manifest.nodes, "wait.yaml");
      const node = compileManifest(manifest).nodes.get("wait");

      expect(node?.nodeType).toBe("wait");
      expect(Object.keys(node?.transitions ?? {})).toEqual(outcomes);
      expect(node?.session).toBeUndefined();
    },
  );

  it.each([
    [
      { kind: "timer", after: 60, until: "2026-11-20T12:00:00Z" },
      /exactly one/,
    ],
    [{ kind: "run", run_id: "target" }, /one direct or task relation/],
    [{ kind: "signal", name: "build", outcomes: ["timeout"] }, /reserved/],
    [
      {
        kind: "signal",
        name: "build",
        outcomes: ["ok"],
        payload_schema: { $ref: "https://example.com/schema" },
      },
      /local references/,
    ],
  ] as const)("W02 refuses invalid condition %j", (condition, refusal) => {
    expect(() => withWait(condition, {})).toThrow(refusal);
  });

  it("W02 refuses a malformed local payload schema at execution and package intake", () => {
    const manifest = withWait(
      {
        kind: "signal",
        name: "build",
        outcomes: ["ok"],
        payload_schema: { type: "unknown" },
      },
      { ok: "done", timeout: "done", cancelled: "done" },
    );

    expect(classifyStoredFlowManifest(manifest)).toMatchObject({
      compatible: false,
      reason: { kind: "invalid_manifest" },
    });
    expect(() =>
      validateGraphManifest(manifest, manifest.nodes, "wait.yaml"),
    ).toThrow(/invalid wait payload_schema/i);
  });

  it("W02 refuses a lower feature floor, missing outcomes and unbounded reentry", () => {
    const on = { kind: "timer", after: 30 };
    const transitions = { elapsed: "done", timeout: "done", cancelled: "done" };
    const belowFloor = withWait(on, transitions, "3.12.0");
    const missing = withWait(on, { elapsed: "done", cancelled: "done" });
    const loop = withWait(on, { ...transitions, elapsed: "wait" });
    const bounded = flowYamlV1Schema.parse({
      ...loop,
      nodes: [
        {
          ...loop.nodes[0],
          rework: {
            allowedTargets: ["wait"],
            workspacePolicies: ["keep"],
            maxLoops: 1,
            onExhaustion: "exhausted",
          },
          transitions: { ...loop.nodes[0].transitions, exhausted: "done" },
        },
      ],
    });

    expect(classifyStoredFlowManifest(belowFloor)).toMatchObject({
      compatible: false,
      reason: { kind: "engine_incompatible" },
    });
    expect(() =>
      validateGraphManifest(bounded, bounded.nodes, "wait.yaml"),
    ).not.toThrow();
    expect(
      compileManifest(bounded).nodes.get("wait")?.transitions.exhausted,
    ).toBe("done");

    expect(() =>
      validateGraphManifest(belowFloor, belowFloor.nodes, "wait.yaml"),
    ).toThrow(/3\.13\.0/);
    expect(() => compileManifest(missing)).toThrow(/timeout/);
    expect(() => validateGraphManifest(loop, loop.nodes, "wait.yaml")).toThrow(
      /unbounded cycle/,
    );
  });
});
