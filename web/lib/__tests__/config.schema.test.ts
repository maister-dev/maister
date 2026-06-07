import { describe, expect, it } from "vitest";

import {
  aiCodingSettingsSchema,
  cliCheckSettingsSchema,
  flowEntrySchema,
  flowYamlV1Schema,
  formSchemaSchema,
  humanSettingsSchema,
  judgeSettingsSchema,
  maisterYamlV2Schema,
  maisterCapabilitiesSchema,
  nodeOutputSchema,
  nodeSchema,
  stepSchema,
} from "@/lib/config.schema";

const goldenMaisterYaml = {
  schemaVersion: 2,
  project: {
    name: "myapp",
    repo_path: "/repos/myapp",
    main_branch: "main",
    branch_prefix: "maister/",
    default_runner: "claude-code",
  },
  flows: [
    {
      id: "bugfix",
      source: "github.com/org/maister-flow-bugfix",
      version: "v1.2.3",
      runner: "claude-code",
    },
    {
      id: "spec-kit",
      source: "github.com/org/maister-flow-spec-kit",
      version: "v0.4.1",
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

  it("accepts project runner bindings without project-scoped executors", () => {
    const parsed = maisterYamlV2Schema.parse({
      ...goldenMaisterYaml,
      project: { ...goldenMaisterYaml.project, default_runner: "claude-code" },
      flows: [
        {
          id: "bugfix",
          source: "github.com/org/maister-flow-bugfix",
          version: "v1.2.3",
          runner: "claude-code",
        },
      ],
    });

    expect(parsed.project.default_runner).toBe("claude-code");
    expect(parsed.flows[0].runner).toBe("claude-code");
  });

  it("rejects legacy executors[]", () => {
    expect(() =>
      maisterYamlV2Schema.parse({
        ...goldenMaisterYaml,
        executors: [{ id: "x", agent: "claude", model: "x" }],
      }),
    ).toThrow();
  });

  it("rejects legacy default_executor", () => {
    expect(() =>
      maisterYamlV2Schema.parse({
        ...goldenMaisterYaml,
        default_executor: "claude-sonnet",
      }),
    ).toThrow();
  });

  it("rejects empty project.name", () => {
    const bad = {
      ...goldenMaisterYaml,
      project: { ...goldenMaisterYaml.project, name: "" },
    };

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

  it("parses scratch capability config with safe defaults", () => {
    const parsed = maisterYamlV2Schema.parse({
      ...goldenMaisterYaml,
      capabilities: {
        mcps: [{ id: "github", command: "github-mcp-server" }],
        skills: [{ id: "aif-implement", path: ".agents/skills/aif" }],
        rules: [{ id: "project-rules", content: "Use project rules" }],
        restrictions: [{ id: "no-global-installs" }],
        settings: [
          {
            id: "codex-default",
            agent: "codex",
            path: ".maister/codex/settings.json",
          },
        ],
        tools: [{ id: "shell", enforceability: "unsupported" }],
      },
    });

    expect(parsed.capabilities.mcps[0]).toMatchObject({
      id: "github",
      kind: "mcp",
      source: "project",
      agents: ["claude", "codex"],
      enforceability: "enforced",
      selected_by_default: true,
    });
    expect(parsed.capabilities.skills[0].enforceability).toBe("instructed");
    expect(parsed.capabilities.settings[0].enforceability).toBe("enforced");
  });
});

describe("aiCodingSettingsSchema runner target", () => {
  it("accepts ACP runner_type and runner target", () => {
    const parsed = aiCodingSettingsSchema.parse({
      runner_type: "acp",
      runner: "claude-code",
      skills: ["aif-implement"],
    });

    expect(parsed.runner_type).toBe("acp");
    expect(parsed.runner).toBe("claude-code");
  });
});

describe("maisterYamlV2Schema — capability_imports[] (M14 T2.4)", () => {
  it("defaults capability_imports to an empty array when absent", () => {
    const parsed = maisterYamlV2Schema.parse(goldenMaisterYaml);

    expect(parsed.capability_imports).toEqual([]);
  });

  it("parses a valid capability_imports entry", () => {
    const parsed = maisterYamlV2Schema.parse({
      ...goldenMaisterYaml,
      capability_imports: [
        {
          id: "aif-skills",
          source: "github.com/org/aif-skills",
          version: "v1.0.0",
        },
      ],
    });

    expect(parsed.capability_imports[0]).toMatchObject({
      id: "aif-skills",
      source: "github.com/org/aif-skills",
      version: "v1.0.0",
    });
  });

  it("accepts the optional trust: explicit flag", () => {
    const parsed = maisterYamlV2Schema.parse({
      ...goldenMaisterYaml,
      capability_imports: [
        {
          id: "custom-mcps",
          source: "github.com/org/custom-mcps",
          version: "v2.1.0",
          trust: "explicit",
        },
      ],
    });

    expect(parsed.capability_imports[0].trust).toBe("explicit");
  });

  it("rejects an import id with a path-traversal segment", () => {
    expect(() =>
      maisterYamlV2Schema.parse({
        ...goldenMaisterYaml,
        capability_imports: [
          { id: "../evil", source: "github.com/org/x", version: "v1.0.0" },
        ],
      }),
    ).toThrow();
  });

  it("rejects an import version with a path-traversal segment", () => {
    expect(() =>
      maisterYamlV2Schema.parse({
        ...goldenMaisterYaml,
        capability_imports: [
          { id: "aif-skills", source: "github.com/org/x", version: ".." },
        ],
      }),
    ).toThrow();
  });

  it("rejects a missing source", () => {
    expect(() =>
      maisterYamlV2Schema.parse({
        ...goldenMaisterYaml,
        capability_imports: [{ id: "aif-skills", version: "v1.0.0" }],
      }),
    ).toThrow();
  });

  it("rejects an unknown trust value", () => {
    expect(() =>
      maisterYamlV2Schema.parse({
        ...goldenMaisterYaml,
        capability_imports: [
          { id: "aif-skills", source: "g", version: "v1.0.0", trust: "always" },
        ],
      }),
    ).toThrow();
  });
});

describe("maisterCapabilitiesSchema", () => {
  it("defaults every capability group to an empty list", () => {
    expect(maisterCapabilitiesSchema.parse({})).toEqual({
      mcps: [],
      skills: [],
      rules: [],
      restrictions: [],
      settings: [],
      tools: [],
      agent_definitions: [],
      env_profiles: [],
    });
  });
});

describe("flowEntrySchema", () => {
  it("runner optional", () => {
    expect(() =>
      flowEntrySchema.parse({ id: "f", source: "s", version: "v" }),
    ).not.toThrow();
  });

  it("rejects legacy executor_override", () => {
    expect(() =>
      flowEntrySchema.parse({
        id: "f",
        source: "s",
        version: "v",
        executor_override: "claude-sonnet",
      }),
    ).toThrow();
  });
});

const goldenFlowYaml = {
  schemaVersion: 1,
  name: "Bugfix",
  runner_profiles: {
    "claude-code": {
      capability_agent: "claude",
      adapter: "claude",
      model: "claude-sonnet-4-6",
      provider: { kind: "anthropic" },
    },
  },
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

  it("rejects legacy recommended_executor", () => {
    expect(() =>
      flowYamlV1Schema.parse({
        ...goldenFlowYaml,
        recommended_executor: "claude-sonnet",
      }),
    ).toThrow();
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

const goldenGraphYaml = {
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

describe("flowYamlV1Schema — graph (nodes[])", () => {
  it("accepts a golden graph manifest", () => {
    expect(() => flowYamlV1Schema.parse(goldenGraphYaml)).not.toThrow();
  });

  it("rejects both steps[] and nodes[] present", () => {
    expect(() =>
      flowYamlV1Schema.parse({
        ...goldenGraphYaml,
        steps: goldenFlowYaml.steps,
      }),
    ).toThrow();
  });

  it("rejects neither steps[] nor nodes[]", () => {
    const { ...noWalker } = { schemaVersion: 1, name: "empty" };

    expect(() => flowYamlV1Schema.parse(noWalker)).toThrow();
  });

  // M11c: settings is now a TYPED per-node-type block (was an opaque passthrough
  // in M11a). The typed ai_coding shape must round-trip known fields with their
  // parsed types — replacing the M11a "opaque passthrough" assertion.
  it("typed-parses a node settings block on an ai_coding node", () => {
    const withSettings = {
      ...goldenGraphYaml,
      nodes: [
        {
          ...goldenGraphYaml.nodes[0],
          settings: { mcps: ["github"], thinkingEffort: "high" },
        },
        ...goldenGraphYaml.nodes.slice(1),
      ],
    };
    const parsed = flowYamlV1Schema.parse(withSettings) as {
      nodes: Array<{ settings?: Record<string, unknown> }>;
    };

    expect(parsed.nodes[0].settings).toMatchObject({
      mcps: ["github"],
      thinkingEffort: "high",
    });
  });

  // The opaque passthrough (`z.record(z.string(), z.unknown())`) accepted any
  // key; the typed schema must NOT. A bogus unknown key on the settings block
  // must be rejected (typed schemas reject unknown keys).
  it("rejects an unknown key on a typed ai_coding settings block", () => {
    const bad = {
      ...goldenGraphYaml,
      nodes: [
        {
          ...goldenGraphYaml.nodes[0],
          settings: { mcps: ["github"], notARealSettingKey: true },
        },
        ...goldenGraphYaml.nodes.slice(1),
      ],
    };

    expect(() => flowYamlV1Schema.parse(bad)).toThrow();
  });
});

// --- M11c: typed per-node `settings` schemas (tasks 1.1–1.6) -----------------
// These exercise the exported settings sub-schemas directly. They are RED until
// the implementor adds the schemas + exports to config.schema.ts.

describe("aiCodingSettingsSchema (M11c)", () => {
  it("accepts a fully-populated ai_coding settings block", () => {
    expect(() =>
      aiCodingSettingsSchema.parse({
        runner_type: "acp",
        runner: "claude-code",
        model: "claude-sonnet-4-6",
        thinkingEffort: "high",
        mcps: ["github", "postgres"],
        tools: { claude: ["Read", "Edit"], codex: ["shell"] },
        skills: ["aif-implement"],
        settingsProfile: "default",
        workspaceAccess: "write",
        artifactAccess: ["plan-summary"],
        permissionMode: "ask",
        limits: { maxDurationMinutes: 30, maxCostUsd: 5 },
        restrictions: ["no-global-installs"],
        enforcement: {
          mcps: "strict",
          tools: "instruct",
          skills: "off",
          restrictions: "strict",
          permissionMode: "instruct",
          workspaceAccess: "strict",
        },
      }),
    ).not.toThrow();
  });

  it("rejects legacy settings.executors", () => {
    expect(() =>
      aiCodingSettingsSchema.parse({
        executors: ["claude-sonnet", "codex-default"],
      }),
    ).toThrow();
  });

  it("accepts an empty ai_coding settings block (every field optional)", () => {
    expect(() => aiCodingSettingsSchema.parse({})).not.toThrow();
  });

  it("rejects an unknown thinkingEffort enum value", () => {
    expect(() =>
      aiCodingSettingsSchema.parse({ thinkingEffort: "extreme" }),
    ).toThrow();
  });

  it("rejects an unknown permissionMode enum value", () => {
    expect(() =>
      aiCodingSettingsSchema.parse({ permissionMode: "yolo" }),
    ).toThrow();
  });

  it("rejects an unknown workspaceAccess enum value", () => {
    expect(() =>
      aiCodingSettingsSchema.parse({ workspaceAccess: "readwrite" }),
    ).toThrow();
  });

  it("rejects malformed tools (array instead of {claude/codex} map)", () => {
    expect(() => aiCodingSettingsSchema.parse({ tools: ["Read"] })).toThrow();
  });

  it("rejects an unknown agent key inside tools", () => {
    expect(() =>
      aiCodingSettingsSchema.parse({ tools: { cursor: ["Read"] } }),
    ).toThrow();
  });

  it("rejects limits.maxDurationMinutes <= 0", () => {
    expect(() =>
      aiCodingSettingsSchema.parse({ limits: { maxDurationMinutes: 0 } }),
    ).toThrow();
    expect(() =>
      aiCodingSettingsSchema.parse({ limits: { maxDurationMinutes: -5 } }),
    ).toThrow();
  });

  it("rejects limits.maxCostUsd <= 0", () => {
    expect(() =>
      aiCodingSettingsSchema.parse({ limits: { maxCostUsd: 0 } }),
    ).toThrow();
  });

  it("rejects an unknown enforcement intent value", () => {
    expect(() =>
      aiCodingSettingsSchema.parse({ enforcement: { mcps: "hard" } }),
    ).toThrow();
  });

  it("accepts each valid enforcement intent (strict|instruct|off)", () => {
    for (const intent of ["strict", "instruct", "off"]) {
      expect(() =>
        aiCodingSettingsSchema.parse({ enforcement: { mcps: intent } }),
      ).not.toThrow();
    }
  });

  it("keeps the enforcement map SPARSE — unset classes are not defaulted at parse", () => {
    // M11c bug fix: per-key `instruct` defaults are NOT injected at parse.
    // A manifest declaring only `enforcement: { mcps: "strict" }` must parse to
    // an enforcement map containing ONLY `mcps`; otherwise the audit snapshot
    // and run-detail panel over-report the five classes the author never set.
    // The `instruct` default is applied at EVALUATION (evaluateNodeEnforcement),
    // not here.
    const parsed = aiCodingSettingsSchema.parse({
      enforcement: { mcps: "strict" },
    }) as { enforcement?: Record<string, string | undefined> };

    expect(parsed.enforcement?.mcps).toBe("strict");
    expect(Object.keys(parsed.enforcement ?? {})).toEqual(["mcps"]);
  });

  it("rejects an unknown top-level key on the ai_coding settings block", () => {
    expect(() => aiCodingSettingsSchema.parse({ bogusKey: 1 })).toThrow();
  });
});

describe("humanSettingsSchema (M11c)", () => {
  it("accepts a fully-populated human settings block", () => {
    expect(() =>
      humanSettingsSchema.parse({
        roles: ["reviewer"],
        assignees: ["alice@example.com"],
        decisions: ["approve", "rework"],
        allowFurtherTracks: true,
        allowTakeover: false,
        slaHours: 24,
        stalenessHint: "review within a day",
        returnRequires: ["review_comments"],
      }),
    ).not.toThrow();
  });

  it("accepts an empty human settings block", () => {
    expect(() => humanSettingsSchema.parse({})).not.toThrow();
  });

  it("rejects slaHours <= 0", () => {
    expect(() => humanSettingsSchema.parse({ slaHours: 0 })).toThrow();
  });

  it("rejects allowTakeover with a non-boolean", () => {
    expect(() => humanSettingsSchema.parse({ allowTakeover: "yes" })).toThrow();
  });

  it("rejects capability fields (mcps) on a human settings block", () => {
    // human carries decision/role shape only — no agent-capability fields.
    expect(() => humanSettingsSchema.parse({ mcps: ["github"] })).toThrow();
  });
});

describe("cliCheckSettingsSchema (M11c)", () => {
  it("accepts a fully-populated cli/check settings block", () => {
    expect(() =>
      cliCheckSettingsSchema.parse({
        command: "pnpm test",
        timeoutMs: 60000,
        environmentPolicy: "whitelist",
        inputArtifacts: ["plan-summary"],
        outputArtifacts: ["test-report"],
        failureClass: "blocking",
      }),
    ).not.toThrow();
  });

  it("accepts an empty cli/check settings block", () => {
    expect(() => cliCheckSettingsSchema.parse({})).not.toThrow();
  });

  it("rejects an unknown environmentPolicy enum value", () => {
    expect(() =>
      cliCheckSettingsSchema.parse({ environmentPolicy: "sandbox" }),
    ).toThrow();
  });

  it("rejects an unknown failureClass enum value", () => {
    expect(() =>
      cliCheckSettingsSchema.parse({ failureClass: "fatal" }),
    ).toThrow();
  });

  it("rejects timeoutMs <= 0", () => {
    expect(() => cliCheckSettingsSchema.parse({ timeoutMs: 0 })).toThrow();
  });

  it("rejects capability fields (mcps/enforcement) on a cli/check block", () => {
    // cli/check carry the command shape only — no capability classes, so no
    // enforcement and no mcps.
    expect(() => cliCheckSettingsSchema.parse({ mcps: ["github"] })).toThrow();
    expect(() =>
      cliCheckSettingsSchema.parse({ enforcement: { mcps: "strict" } }),
    ).toThrow();
  });
});

describe("judgeSettingsSchema (M11c)", () => {
  it("accepts the capability-bearing judge shape", () => {
    expect(() =>
      judgeSettingsSchema.parse({
        model: "claude-sonnet-4-6",
        thinkingEffort: "medium",
        mcps: ["github"],
        tools: { claude: ["Read"] },
        skills: ["aif-review"],
        restrictions: ["no-network"],
        permissionMode: "deny",
        limits: { maxDurationMinutes: 10 },
        enforcement: {
          mcps: "strict",
          tools: "instruct",
          skills: "off",
          restrictions: "strict",
          permissionMode: "instruct",
          workspaceAccess: "instruct",
        },
      }),
    ).not.toThrow();
  });

  it("accepts an empty judge settings block", () => {
    expect(() => judgeSettingsSchema.parse({})).not.toThrow();
  });

  it("rejects an unknown permissionMode on the judge block", () => {
    expect(() =>
      judgeSettingsSchema.parse({ permissionMode: "maybe" }),
    ).toThrow();
  });

  it("rejects an unknown enforcement intent on the judge block", () => {
    expect(() =>
      judgeSettingsSchema.parse({ enforcement: { tools: "loose" } }),
    ).toThrow();
  });
});

describe("nodeSchema typed settings wiring (M11c)", () => {
  it("rejects an unknown thinkingEffort inside an ai_coding node settings", () => {
    expect(() =>
      nodeSchema.parse({
        id: "i",
        type: "ai_coding",
        action: { prompt: "go" },
        settings: { thinkingEffort: "ludicrous" },
      }),
    ).toThrow();
  });

  it("rejects an unknown failureClass inside a cli node settings", () => {
    expect(() =>
      nodeSchema.parse({
        id: "c",
        type: "cli",
        action: { command: "pnpm test" },
        settings: { failureClass: "explode" },
      }),
    ).toThrow();
  });

  it("rejects a capability enforcement block on a cli node settings", () => {
    expect(() =>
      nodeSchema.parse({
        id: "c",
        type: "cli",
        action: { command: "pnpm test" },
        settings: { enforcement: { mcps: "strict" } },
      }),
    ).toThrow();
  });

  it("accepts a typed human settings block on a human node", () => {
    expect(() =>
      nodeSchema.parse({
        id: "review",
        type: "human",
        finish: { human: { decisions: ["approve"] } },
        transitions: { approve: "done" },
        settings: { roles: ["reviewer"], allowTakeover: true, slaHours: 24 },
      }),
    ).not.toThrow();
  });
});

describe("nodeSchema", () => {
  it("rejects an unknown node type via discriminated union", () => {
    expect(() =>
      nodeSchema.parse({ id: "x", type: "merge", action: {} }),
    ).toThrow();
  });

  it("ai_coding node requires action.prompt", () => {
    expect(() =>
      nodeSchema.parse({ id: "i", type: "ai_coding", action: {} }),
    ).toThrow();
  });

  it("rejects an unsupported workspace policy in rework", () => {
    expect(() =>
      nodeSchema.parse({
        id: "review",
        type: "human",
        finish: { human: { decisions: ["rework"] } },
        transitions: { rework: "i" },
        rework: {
          allowedTargets: ["i"],
          workspacePolicies: ["teleport"],
          maxLoops: 2,
        },
      }),
    ).toThrow();
  });

  // M17 ADR-054: criticality field on human node settings
  it("human node accepts optional criticality in settings", () => {
    const base = {
      id: "review",
      type: "human",
      settings: {},
      finish: { human: { decisions: ["approve"] } },
      transitions: { approve: "done" },
    };

    expect(() =>
      nodeSchema.parse({ ...base, settings: { criticality: "low" } }),
    ).not.toThrow();
    expect(() =>
      nodeSchema.parse({ ...base, settings: { criticality: "medium" } }),
    ).not.toThrow();
    expect(() =>
      nodeSchema.parse({ ...base, settings: { criticality: "high" } }),
    ).not.toThrow();
    expect(() =>
      nodeSchema.parse({ ...base, settings: { criticality: "critical" } }),
    ).not.toThrow();
  });

  it("human node rejects invalid criticality values in settings", () => {
    const base = {
      id: "review",
      type: "human",
      finish: { human: { decisions: ["approve"] } },
      transitions: { approve: "done" },
    };

    expect(() =>
      nodeSchema.parse({
        ...base,
        settings: { criticality: "severe" },
      }),
    ).toThrow();
  });

  it("human node without criticality is valid", () => {
    expect(() =>
      nodeSchema.parse({
        id: "review",
        type: "human",
        settings: { roles: ["reviewer"] },
        finish: { human: { decisions: ["approve"] } },
        transitions: { approve: "done" },
      }),
    ).not.toThrow();
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

  // M17 ADR-054: criticality field on human steps
  it("human step accepts optional criticality: low|medium|high|critical", () => {
    const base = { id: "x", type: "human", form_schema: "schemas/review.json" };

    expect(() =>
      stepSchema.parse({ ...base, criticality: "low" }),
    ).not.toThrow();
    expect(() =>
      stepSchema.parse({ ...base, criticality: "medium" }),
    ).not.toThrow();
    expect(() =>
      stepSchema.parse({ ...base, criticality: "high" }),
    ).not.toThrow();
    expect(() =>
      stepSchema.parse({ ...base, criticality: "critical" }),
    ).not.toThrow();
  });

  it("human step rejects invalid criticality values", () => {
    const base = { id: "x", type: "human", form_schema: "schemas/review.json" };

    expect(() =>
      stepSchema.parse({ ...base, criticality: "urgent" }),
    ).toThrow();
    expect(() =>
      stepSchema.parse({ ...base, criticality: "CRITICAL" }),
    ).toThrow();
  });

  it("human step with absent criticality is valid", () => {
    expect(() =>
      stepSchema.parse({
        id: "x",
        type: "human",
        form_schema: "schemas/review.json",
      }),
    ).not.toThrow();
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
        fields: [{ name: "n", type: "tuple" }],
      }),
    ).toThrow();
  });

  it("accepts a nested object type with recursive fields (M26)", () => {
    expect(() =>
      formSchemaSchema.parse({
        schemaVersion: 1,
        fields: [
          {
            name: "result",
            type: "object",
            required: true,
            fields: [
              { name: "ok", type: "boolean" },
              {
                name: "inner",
                type: "object",
                fields: [{ name: "leaf", type: "string" }],
              },
            ],
          },
        ],
      }),
    ).not.toThrow();
  });
});

// --- M26 (ADR-063): node output.result declaration --------------------------
describe("nodeOutputSchema.result (M26)", () => {
  it("accepts a node output with a valid result declaration", () => {
    const parsed = nodeOutputSchema.parse({
      result: { schema: "./schemas/output.json", required: true },
    }) as { result?: { schema: string; required?: boolean } };

    expect(parsed.result).toMatchObject({
      schema: "./schemas/output.json",
      required: true,
    });
  });

  it("accepts result without required (required is optional)", () => {
    const parsed = nodeOutputSchema.parse({
      result: { schema: "./schemas/output.json" },
    }) as { result?: { schema: string; required?: boolean } };

    expect(parsed.result?.schema).toBe("./schemas/output.json");
    expect(parsed.result?.required).toBeUndefined();
  });

  it("still parses a node output WITHOUT result (back-compat)", () => {
    expect(() =>
      nodeOutputSchema.parse({
        produces: [{ id: "plan", kind: "diff" }],
      }),
    ).not.toThrow();
    expect(() => nodeOutputSchema.parse({})).not.toThrow();
  });

  it("rejects result with an empty schema string", () => {
    expect(() => nodeOutputSchema.parse({ result: { schema: "" } })).toThrow();
  });

  it("rejects result with a missing schema", () => {
    expect(() =>
      nodeOutputSchema.parse({ result: { required: true } }),
    ).toThrow();
  });

  it("rejects result with a non-boolean required", () => {
    expect(() =>
      nodeOutputSchema.parse({
        result: { schema: "./s.json", required: "yes" },
      }),
    ).toThrow();
  });

  it("rejects result with an unknown key (strict result shape)", () => {
    expect(() =>
      nodeOutputSchema.parse({
        result: { schema: "./s.json", bogus: 1 },
      }),
    ).toThrow();
  });

  it("wires output.result through a full ai_coding node", () => {
    expect(() =>
      nodeSchema.parse({
        id: "implement",
        type: "ai_coding",
        action: { prompt: "go" },
        output: { result: { schema: "./schemas/impl.json" } },
      }),
    ).not.toThrow();
  });
});
