import { describe, expect, it } from "vitest";

import {
  executorSchema,
  flowEntrySchema,
  flowYamlV1Schema,
  formSchemaSchema,
  maisterYamlV2Schema,
  stepSchema,
} from "@/lib/config.schema";

const goldenMaisterYaml = {
  schemaVersion: 2,
  project: {
    name: "myapp",
    repo_path: "/repos/myapp",
    main_branch: "main",
    branch_prefix: "maister/",
  },
  executors: [
    {
      id: "claude-sonnet",
      agent: "claude",
      model: "claude-sonnet-4-6",
    },
    {
      id: "claude-glm-ccr",
      agent: "claude",
      model: "glm-4.6",
      router: "ccr",
    },
    {
      id: "codex-default",
      agent: "codex",
      model: "gpt-5-codex",
      env: {
        ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
        ANTHROPIC_AUTH_TOKEN: "fake-token",
      },
    },
  ],
  default_executor: "claude-sonnet",
  flows: [
    {
      id: "bugfix",
      source: "github.com/org/maister-flow-bugfix",
      version: "v1.2.3",
    },
    {
      id: "spec-kit",
      source: "github.com/org/maister-flow-spec-kit",
      version: "v0.4.1",
      executor_override: "claude-glm-ccr",
    },
  ],
};

describe("maisterYamlV2Schema", () => {
  it("accepts a golden v2 manifest", () => {
    expect(() => maisterYamlV2Schema.parse(goldenMaisterYaml)).not.toThrow();
  });

  it("rejects wrong schemaVersion", () => {
    expect(() =>
      maisterYamlV2Schema.parse({ ...goldenMaisterYaml, schemaVersion: 1 }),
    ).toThrow(/schemaVersion/);
  });

  it("rejects missing executors[]", () => {
    expect(() =>
      maisterYamlV2Schema.parse({ ...goldenMaisterYaml, executors: [] }),
    ).toThrow();
  });

  it("rejects unknown agent in executor", () => {
    const bad = {
      ...goldenMaisterYaml,
      executors: [
        ...goldenMaisterYaml.executors,
        { id: "x", agent: "cursor", model: "x" },
      ],
    };

    expect(() => maisterYamlV2Schema.parse(bad)).toThrow();
  });

  it("rejects unknown router value", () => {
    const bad = {
      ...goldenMaisterYaml,
      executors: [{ id: "x", agent: "claude", model: "x", router: "noop" }],
    };

    expect(() => maisterYamlV2Schema.parse(bad)).toThrow();
  });

  it("rejects empty project.name", () => {
    const bad = {
      ...goldenMaisterYaml,
      project: { ...goldenMaisterYaml.project, name: "" },
    };

    expect(() => maisterYamlV2Schema.parse(bad)).toThrow();
  });

  it("rejects empty default_executor", () => {
    const bad = { ...goldenMaisterYaml, default_executor: "" };

    expect(() => maisterYamlV2Schema.parse(bad)).toThrow();
  });

  it("rejects a relative repo_path", () => {
    const bad = {
      ...goldenMaisterYaml,
      project: { ...goldenMaisterYaml.project, repo_path: "repos/myapp" },
    };

    expect(() => maisterYamlV2Schema.parse(bad)).toThrow(/absolute path/);
  });

  it("rejects a repo_path with a '..' traversal segment", () => {
    const bad = {
      ...goldenMaisterYaml,
      project: { ...goldenMaisterYaml.project, repo_path: "/repos/../etc" },
    };

    expect(() => maisterYamlV2Schema.parse(bad)).toThrow(/absolute path/);
  });

  it("rejects flow with missing version", () => {
    const bad = {
      ...goldenMaisterYaml,
      flows: [{ id: "x", source: "g" }],
    };

    expect(() => maisterYamlV2Schema.parse(bad)).toThrow();
  });
});

describe("executorSchema", () => {
  it("env is optional and accepts string-keyed string map", () => {
    expect(
      executorSchema.parse({
        id: "x",
        agent: "claude",
        model: "y",
        env: { A: "1", B: "2" },
      }).env,
    ).toEqual({ A: "1", B: "2" });
  });

  it("rejects non-string env values", () => {
    expect(() =>
      executorSchema.parse({
        id: "x",
        agent: "claude",
        model: "y",
        env: { A: 1 as unknown as string },
      }),
    ).toThrow();
  });
});

describe("flowEntrySchema", () => {
  it("executor_override optional", () => {
    expect(() =>
      flowEntrySchema.parse({ id: "f", source: "s", version: "v" }),
    ).not.toThrow();
  });
});

const goldenFlowYaml = {
  schemaVersion: 1,
  name: "Bugfix",
  recommended_executor: "claude-sonnet",
  steps: [
    {
      id: "plan",
      type: "agent",
      mode: "new-session",
      prompt: "/aif-plan {{ task.prompt }}",
    },
    {
      id: "lint",
      type: "cli",
      command: "pnpm lint",
    },
    {
      id: "budget",
      type: "guard",
      cost: 5,
    },
    {
      id: "review",
      type: "human",
      form_schema: "./schemas/review.json",
      on_reject: { goto_step: "plan", comments_var: "review_comments" },
    },
  ],
};

describe("flowYamlV1Schema", () => {
  it("accepts a golden v1 flow manifest with all 4 step types", () => {
    expect(() => flowYamlV1Schema.parse(goldenFlowYaml)).not.toThrow();
  });

  it("rejects wrong schemaVersion", () => {
    expect(() =>
      flowYamlV1Schema.parse({ ...goldenFlowYaml, schemaVersion: 2 }),
    ).toThrow();
  });

  it("rejects empty steps[]", () => {
    expect(() =>
      flowYamlV1Schema.parse({ ...goldenFlowYaml, steps: [] }),
    ).toThrow();
  });

  it("rejects step with unknown type via discriminated union", () => {
    const bad = {
      ...goldenFlowYaml,
      steps: [...goldenFlowYaml.steps, { id: "x", type: "unknown" }],
    };

    expect(() => flowYamlV1Schema.parse(bad)).toThrow();
  });
});

describe("stepSchema", () => {
  it("agent step requires prompt + mode", () => {
    expect(() =>
      stepSchema.parse({ id: "x", type: "agent", mode: "new-session" }),
    ).toThrow();

    expect(() =>
      stepSchema.parse({ id: "x", type: "agent", prompt: "go" }),
    ).toThrow();
  });

  it("human step requires form_schema", () => {
    expect(() => stepSchema.parse({ id: "x", type: "human" })).toThrow();
  });
});

describe("formSchemaSchema", () => {
  it("requires schemaVersion number", () => {
    expect(() => formSchemaSchema.parse({ fields: [] })).toThrow();
  });

  it("accepts schemaVersion + field types", () => {
    expect(() =>
      formSchemaSchema.parse({
        schemaVersion: 1,
        fields: [
          { name: "n", type: "string", required: true },
          { name: "x", type: "number" },
          { name: "b", type: "boolean", default: false },
          { name: "e", type: "enum", options: ["a", "b"] },
          { name: "a", type: "array" },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects unknown field type", () => {
    expect(() =>
      formSchemaSchema.parse({
        schemaVersion: 1,
        fields: [{ name: "n", type: "object" }],
      }),
    ).toThrow();
  });
});
