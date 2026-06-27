import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { loadFlowManifest } from "@/lib/config";
import {
  flowRunnerConfigSchema,
  judgeSettingsSchema,
} from "@/lib/config.schema";
import { isMaisterError } from "@/lib/errors";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "config-sessions-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

type GraphManifest = {
  schemaVersion: number;
  name: string;
  compat: { engine_min: string };
  sessions?: Record<string, { runner: unknown }>;
  nodes: Array<Record<string, unknown>>;
};

// implement (default session) -> review (named "review" session) -> done.
function baseManifest(): GraphManifest {
  return {
    schemaVersion: 1,
    name: "session-flow",
    compat: { engine_min: "2.0.0" },
    sessions: { review: { runner: "claude-opus" } },
    nodes: [
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "/aif-implement {{ task.prompt }}" },
        transitions: { success: "review" },
      },
      {
        id: "review",
        type: "ai_coding",
        action: { prompt: "review the change" },
        session: "review",
        transitions: { success: "done" },
      },
    ],
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

describe("loadFlowManifest — sessions (M42)", () => {
  it("accepts a node joining a declared named session at engine_min 2.0.0", async () => {
    const manifest = await loadFlowManifest(await writeGraph("valid.yaml"));
    const review = manifest.nodes?.find((n) => n.id === "review");

    expect((review as { session?: string }).session).toBe("review");
  });

  it("accepts a node joining the implicit default session", async () => {
    const manifest = await loadFlowManifest(
      await writeGraph("default-session.yaml", (m) => {
        delete m.sessions;
        m.nodes[1].session = "default";
      }),
    );

    expect(manifest.nodes).toHaveLength(2);
  });

  it("rejects a node referencing an undefined session", async () => {
    const path = await writeGraph("undefined-session.yaml", (m) => {
      m.nodes[1].session = "ghost";
    });

    await expectConfigError(path, "undefined session", "ghost");
  });

  it("rejects a consensus node that declares a session", async () => {
    const path = await writeGraph("consensus-session.yaml", (m) => {
      m.nodes = [
        {
          id: "implement",
          type: "ai_coding",
          action: { prompt: "x" },
          transitions: { success: "vote" },
        },
        {
          id: "vote",
          type: "consensus",
          prompt: "decide",
          session: "review",
          participants: [
            { id: "a", runner: "codex" },
            { id: "b", runner: "claude" },
          ],
          material_axes: ["scope"],
          synthesizer: { runner: "claude" },
          output: {
            produces: [
              { id: "consensus_plan", kind: "plan", current: true },
              { id: "debate_log", kind: "human_note", current: true },
            ],
          },
          transitions: { success: "done" },
        },
      ];
    });

    await expectConfigError(path, "consensus", "must not declare a session");
  });

  it("rejects session features below engine_min 2.0.0", async () => {
    const path = await writeGraph("old-engine.yaml", (m) => {
      m.compat.engine_min = "1.9.0";
    });

    await expectConfigError(path, "2.0.0");
  });

  it("accepts a judge node bearing a runner", async () => {
    const manifest = await loadFlowManifest(
      await writeGraph("judge-runner.yaml", (m) => {
        m.nodes[1].transitions = { success: "judge" };
        m.nodes.push({
          id: "judge",
          type: "judge",
          action: { prompt: "judge it" },
          settings: {
            runner: { capability_agent: "claude", model: "claude-opus-4-8" },
          },
          transitions: { success: "done" },
        });
      }),
    );

    const judge = manifest.nodes?.find((n) => n.id === "judge");

    expect(judge?.type).toBe("judge");
  });
});

describe("flowRunnerConfigSchema (M42 unified runner config)", () => {
  it("parses effort + env:NAME values", () => {
    const parsed = flowRunnerConfigSchema.parse({
      capability_agent: "claude",
      model: "claude-opus-4-8",
      effort: "high",
      env: { ANTHROPIC_LOG: "env:ANTHROPIC_LOG" },
    });

    expect(parsed.effort).toBe("high");
    expect(parsed.env).toEqual({ ANTHROPIC_LOG: "env:ANTHROPIC_LOG" });
  });

  it("rejects an env value that is not an env:NAME reference", () => {
    const result = flowRunnerConfigSchema.safeParse({
      capability_agent: "claude",
      env: { SECRET: "literal-secret" },
    });

    expect(result.success).toBe(false);
  });
});

describe("judgeSettingsSchema (M42 — runner-bearing, model removed)", () => {
  it("accepts a runner slot", () => {
    expect(
      judgeSettingsSchema.safeParse({ runner: "claude-opus" }).success,
    ).toBe(true);
  });

  it("rejects the removed model field", () => {
    expect(
      judgeSettingsSchema.safeParse({ model: "claude-opus-4-8" }).success,
    ).toBe(false);
  });
});
