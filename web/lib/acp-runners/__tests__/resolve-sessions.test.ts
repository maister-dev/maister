import { describe, expect, it } from "vitest";

import {
  autoMatchRunners,
  resolveRunSessions,
  resolveRunnerSlot,
  resolveSlotConfig,
  type RunnerCatalogEntry,
  type RunSessionResolutionInput,
} from "@/lib/acp-runners/resolve";

function runner(
  input: Partial<RunnerCatalogEntry> &
    Pick<RunnerCatalogEntry, "id" | "capabilityAgent" | "model">,
): RunnerCatalogEntry {
  return {
    adapter: input.capabilityAgent,
    providerKind: "anthropic",
    permissionPolicy: "default",
    enabled: true,
    ready: true,
    ...input,
  };
}

const claudeOpus = runner({
  id: "claude-opus",
  capabilityAgent: "claude",
  model: "claude-opus-4-8",
});
const claudeSonnet = runner({
  id: "claude-sonnet",
  capabilityAgent: "claude",
  model: "claude-sonnet-4-6",
});
const codexGpt = runner({
  id: "codex-gpt",
  capabilityAgent: "codex",
  model: "gpt-5-codex",
  providerKind: "openai",
});

const catalog = [claudeOpus, claudeSonnet, codexGpt];

describe("resolveSlotConfig", () => {
  it("derefs a string ref through runner_profiles", () => {
    const config = resolveSlotConfig("primary", {
      primary: {
        runner_type: "acp",
        capability_agent: "claude",
        model: "claude-opus-4-8",
        permission_policy: "default",
      },
    });

    expect(config.model).toBe("claude-opus-4-8");
  });

  it("passes an inline config object through unchanged", () => {
    const inline = {
      runner_type: "acp" as const,
      capability_agent: "codex" as const,
      model: "gpt-5-codex",
      permission_policy: "default" as const,
    };

    expect(resolveSlotConfig(inline, undefined)).toBe(inline);
  });

  it("throws CONFIG for an unknown profile ref", () => {
    expect(() => resolveSlotConfig("ghost", {})).toThrowError(
      /unknown runner profile "ghost"/,
    );
  });
});

describe("autoMatchRunners", () => {
  it("matches on capability + model + provider", () => {
    const matches = autoMatchRunners(
      {
        runner_type: "acp",
        capability_agent: "claude",
        model: "claude-opus-4-8",
        provider: { kind: "anthropic" },
        permission_policy: "default",
      },
      catalog,
    );

    expect(matches.map((r) => r.id)).toEqual(["claude-opus"]);
  });

  it("matches every capability runner when model/provider are unpinned", () => {
    const matches = autoMatchRunners(
      {
        runner_type: "acp",
        capability_agent: "claude",
        permission_policy: "default",
      },
      catalog,
    );

    expect(matches.map((r) => r.id)).toEqual(["claude-opus", "claude-sonnet"]);
  });

  it("excludes disabled and not-ready runners", () => {
    const matches = autoMatchRunners(
      {
        runner_type: "acp",
        capability_agent: "claude",
        permission_policy: "default",
      },
      [
        { ...claudeOpus, enabled: false },
        { ...claudeSonnet, ready: false },
      ],
    );

    expect(matches).toHaveLength(0);
  });
});

describe("resolveRunnerSlot", () => {
  const base = {
    runnerProfiles: undefined,
    runners: catalog,
  };

  it("returns null for a config-less slot with no override/binding", () => {
    expect(
      resolveRunnerSlot({
        ...base,
        slotKey: "session:default",
        slot: undefined,
      }),
    ).toBeNull();
  });

  it("prefers an ephemeral override over everything", () => {
    const resolved = resolveRunnerSlot({
      ...base,
      slotKey: "session:default",
      slot: "claude-sonnet",
      overrideRunnerId: "codex-gpt",
      binding: {
        slotKey: "session:default",
        mappedRunnerId: "claude-opus",
        status: "Mapped",
      },
    });

    expect(resolved).toMatchObject({
      runnerId: "codex-gpt",
      runnerResolutionTier: "launchOverride",
      resolutionSource: "launch-dialog",
    });
  });

  it("uses a Mapped binding before auto-match", () => {
    const resolved = resolveRunnerSlot({
      ...base,
      slotKey: "session:review",
      slot: {
        runner_type: "acp",
        capability_agent: "claude",
        permission_policy: "default",
      },
      binding: {
        slotKey: "session:review",
        mappedRunnerId: "claude-sonnet",
        status: "Mapped",
      },
    });

    expect(resolved).toMatchObject({
      runnerId: "claude-sonnet",
      runnerResolutionTier: "binding",
      resolutionSource: "session:review",
    });
  });

  it("ignores a Pending binding and falls through to auto-match", () => {
    const resolved = resolveRunnerSlot({
      ...base,
      slotKey: "session:review",
      slot: {
        runner_type: "acp",
        capability_agent: "codex",
        model: "gpt-5-codex",
        permission_policy: "default",
      },
      binding: {
        slotKey: "session:review",
        mappedRunnerId: null,
        status: "Pending",
      },
    });

    expect(resolved).toMatchObject({
      runnerId: "codex-gpt",
      runnerResolutionTier: "autoMatch",
    });
  });

  it("resolves a bare profile-ref that IS a host runner id (stepTarget)", () => {
    const resolved = resolveRunnerSlot({
      ...base,
      slotKey: "session:default",
      slot: "claude-opus",
    });

    expect(resolved).toMatchObject({
      runnerId: "claude-opus",
      runnerResolutionTier: "stepTarget",
    });
  });

  it("throws CONFIG when intent matches multiple host runners", () => {
    expect(() =>
      resolveRunnerSlot({
        ...base,
        slotKey: "session:default",
        slot: {
          runner_type: "acp",
          capability_agent: "claude",
          permission_policy: "default",
        },
      }),
    ).toThrowError(/matches 2 host runners by intent/);
  });

  it("throws EXECUTOR_UNAVAILABLE when no host matches the intent", () => {
    expect(() =>
      resolveRunnerSlot({
        ...base,
        slotKey: "session:default",
        slot: {
          runner_type: "acp",
          capability_agent: "claude",
          model: "claude-haiku-4-5",
          permission_policy: "default",
        },
      }),
    ).toThrowError(/no enabled\+ready host runner/);
  });
});

describe("resolveRunSessions", () => {
  function input(
    overrides: Partial<RunSessionResolutionInput>,
  ): RunSessionResolutionInput {
    return {
      sessions: [],
      runnerProfiles: undefined,
      bindings: [],
      projectFlow: { defaultRunnerId: null },
      platformFlow: { defaultRunnerId: null },
      project: { defaultRunnerId: null },
      platform: { defaultRunnerId: "claude-opus" },
      runners: catalog,
      ...overrides,
    };
  }

  it("resolves a config-less default session via the platform default chain", () => {
    const out = resolveRunSessions(input({ sessions: [{ name: "default" }] }));

    expect(out).toEqual([
      expect.objectContaining({
        sessionName: "default",
        runnerId: "claude-opus",
        runnerResolutionTier: "platformDefault",
        resolutionSource: "platformDefault",
      }),
    ]);
  });

  it("prefers the project-flow default over the platform default", () => {
    const out = resolveRunSessions(
      input({
        sessions: [{ name: "default" }],
        projectFlow: { defaultRunnerId: "claude-sonnet" },
      }),
    );

    expect(out[0]).toMatchObject({
      runnerId: "claude-sonnet",
      runnerResolutionTier: "projectFlowDefault",
    });
  });

  it("resolves multiple sessions independently (auto-match + binding)", () => {
    const out = resolveRunSessions(
      input({
        sessions: [
          { name: "default" },
          {
            name: "review",
            runner: {
              runner_type: "acp",
              capability_agent: "codex",
              model: "gpt-5-codex",
              permission_policy: "default",
            },
          },
        ],
        bindings: [
          {
            slotKey: "session:default",
            mappedRunnerId: "claude-sonnet",
            status: "Mapped",
          },
        ],
      }),
    );

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      sessionName: "default",
      runnerId: "claude-sonnet",
      runnerResolutionTier: "binding",
    });
    expect(out[1]).toMatchObject({
      sessionName: "review",
      runnerId: "codex-gpt",
      runnerResolutionTier: "autoMatch",
    });
  });

  it("applies a per-session ephemeral override", () => {
    const out = resolveRunSessions(
      input({
        sessions: [{ name: "default" }],
        ephemeralOverrides: { default: "codex-gpt" },
      }),
    );

    expect(out[0]).toMatchObject({
      runnerId: "codex-gpt",
      runnerResolutionTier: "launchOverride",
    });
  });
});
