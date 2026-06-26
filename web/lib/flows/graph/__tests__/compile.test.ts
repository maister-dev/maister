import type { FlowYamlV1 } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { compileManifest, resolveTransition } from "@/lib/flows/graph/compile";

const linear: FlowYamlV1 = {
  schemaVersion: 1,
  name: "greet",
  steps: [
    { id: "hello", type: "cli", command: "echo hi" },
    { id: "plan", type: "agent", mode: "new-session", prompt: "/aif-plan" },
    { id: "review", type: "human", form_schema: "./r.json" },
  ],
} as FlowYamlV1;

const graph: FlowYamlV1 = {
  schemaVersion: 1,
  name: "aif",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
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

describe("compileManifest — linear steps[]", () => {
  it("compiles each step to a single-action node chained by success -> next -> done", () => {
    const g = compileManifest(linear);

    expect(g.entry).toBe("hello");
    expect(g.order).toEqual(["hello", "plan", "review"]);

    const hello = g.nodes.get("hello")!;

    expect(hello.nodeType).toBe("cli");
    expect(hello.source.kind).toBe("step");
    expect(hello.transitions).toEqual({ success: "plan" });

    expect(g.nodes.get("plan")!.nodeType).toBe("ai_coding");
    expect(g.nodes.get("plan")!.transitions).toEqual({ success: "review" });

    const review = g.nodes.get("review")!;

    expect(review.nodeType).toBe("human");
    expect(review.transitions).toEqual({ success: "done" });
    expect(review.rework).toBeUndefined();
    expect(review.gates).toEqual([]);
  });

  it("resolveTransition returns null at the terminal step", () => {
    const g = compileManifest(linear);

    expect(resolveTransition(g.nodes.get("hello")!, "success")).toBe("plan");
    expect(resolveTransition(g.nodes.get("review")!, "success")).toBeNull();
  });
});

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

  it("assigns legacy linear agent steps to the default session", () => {
    const g = compileManifest(linear);

    expect(g.nodes.get("plan")?.session).toBe("default"); // agent
    expect(g.nodes.get("hello")?.session).toBeUndefined(); // cli
    expect(g.nodes.get("review")?.session).toBeUndefined(); // human
    expect([...g.sessions.keys()]).toEqual(["default"]);
  });
});
