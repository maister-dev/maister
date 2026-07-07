import { describe, expect, it } from "vitest";

import {
  baseModelName,
  resolveRunSessions,
  resolveRunnerSlot,
  resolveSlotConfig,
  runnerIntentCandidates,
  type RunnerCatalogEntry,
  type RunSessionResolutionInput,
} from "@/lib/acp-runners/resolve";
import { isMaisterError } from "@/lib/errors";

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

function expectMaisterCode(
  fn: () => unknown,
  code: "CONFIG" | "EXECUTOR_UNAVAILABLE",
): void {
  try {
    fn();
    expect.unreachable(`expected ${code}`);
  } catch (err) {
    expect(isMaisterError(err)).toBe(true);
    if (isMaisterError(err)) {
      expect(err.code).toBe(code);
    }
  }
}

describe("baseModelName", () => {
  it("strips exactly one trailing model variant suffix", () => {
    expect(baseModelName("claude-opus-4-8[1m]")).toBe("claude-opus-4-8");
    expect(baseModelName("claude-opus-4-8[1m][beta]")).toBe(
      "claude-opus-4-8[1m]",
    );
    expect(baseModelName("claude-opus-4-8")).toBe("claude-opus-4-8");
  });
});

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

describe("runnerIntentCandidates", () => {
  it("grades exact matches separately from same-capability fallback candidates", () => {
    const candidates = runnerIntentCandidates(
      {
        runner_type: "acp",
        capability_agent: "claude",
        model: "claude-opus-4-8",
        provider: { kind: "anthropic" },
        permission_policy: "default",
      },
      catalog,
    );

    expect(candidates.exact.map((r) => r.id)).toEqual(["claude-opus"]);
    expect(candidates.sameCapability.map((r) => r.id)).toEqual([
      "claude-opus",
      "claude-sonnet",
    ]);
  });

  it("matches every capability runner when model/provider are unpinned", () => {
    const candidates = runnerIntentCandidates(
      {
        runner_type: "acp",
        capability_agent: "claude",
        permission_policy: "default",
      },
      catalog,
    );

    expect(candidates.exact.map((r) => r.id)).toEqual([
      "claude-opus",
      "claude-sonnet",
    ]);
  });

  it("excludes disabled and not-ready runners", () => {
    const candidates = runnerIntentCandidates(
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

    expect(candidates).toEqual({ exact: [], sameCapability: [] });
  });
});

describe("resolveRunnerSlot", () => {
  const base = {
    runnerProfiles: undefined,
    runners: catalog,
    project: { defaultRunnerId: null },
    platform: { defaultRunnerId: "claude-opus" },
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

  it("selects an exact intent match silently", () => {
    const resolved = resolveRunnerSlot({
      ...base,
      slotKey: "session:implement",
      slot: {
        runner_type: "acp",
        capability_agent: "claude",
        model: "claude-opus-4-8",
        provider: { kind: "anthropic" },
        permission_policy: "default",
      },
    });

    expect(resolved).toMatchObject({
      runnerId: "claude-opus",
      runnerResolutionTier: "autoMatch",
      resolutionSource: "session:implement",
    });
    expect(resolved?.resolutionWarning).toBeUndefined();
  });

  it("falls back to a same-base model variant with a warning", () => {
    const resolved = resolveRunnerSlot({
      ...base,
      runners: [
        runner({
          id: "claude-opus-1m",
          capabilityAgent: "claude",
          model: "claude-opus-4-8[1m]",
        }),
      ],
      slotKey: "session:implement",
      slot: {
        runner_type: "acp",
        capability_agent: "claude",
        model: "claude-opus-4-8",
        provider: { kind: "anthropic" },
        permission_policy: "default",
      },
    });

    expect(resolved).toMatchObject({
      runnerId: "claude-opus-1m",
      runnerResolutionTier: "autoMatch",
      resolutionWarning: {
        code: "runner_intent_soft_mismatch",
        requested: { model: "claude-opus-4-8", providerKind: "anthropic" },
        launched: {
          runnerId: "claude-opus-1m",
          model: "claude-opus-4-8[1m]",
          providerKind: "anthropic",
        },
      },
    });
  });

  it("falls back on provider-kind mismatch with a warning", () => {
    const resolved = resolveRunnerSlot({
      ...base,
      runners: [
        runner({
          id: "claude-compatible",
          capabilityAgent: "claude",
          model: "claude-opus-4-8",
          providerKind: "anthropic_compatible",
        }),
      ],
      slotKey: "session:review",
      slot: {
        runner_type: "acp",
        capability_agent: "claude",
        model: "claude-opus-4-8",
        provider: { kind: "anthropic" },
        permission_policy: "default",
      },
    });

    expect(resolved).toMatchObject({
      runnerId: "claude-compatible",
      resolutionWarning: {
        requested: { providerKind: "anthropic" },
        launched: { providerKind: "anthropic_compatible" },
      },
    });
  });

  it("combines model and provider mismatch into one warning", () => {
    const resolved = resolveRunnerSlot({
      ...base,
      runners: [
        runner({
          id: "claude-compatible-1m",
          capabilityAgent: "claude",
          model: "claude-opus-4-8[1m]",
          providerKind: "anthropic_compatible",
        }),
      ],
      slotKey: "session:review",
      slot: {
        runner_type: "acp",
        capability_agent: "claude",
        model: "claude-opus-4-8",
        provider: { kind: "anthropic" },
        permission_policy: "default",
      },
    });

    expect(resolved?.resolutionWarning).toMatchObject({
      requested: {
        model: "claude-opus-4-8",
        providerKind: "anthropic",
      },
      launched: {
        model: "claude-opus-4-8[1m]",
        providerKind: "anthropic_compatible",
      },
    });
  });

  it("ranks same base model before project and platform defaults", () => {
    const resolved = resolveRunnerSlot({
      ...base,
      runners: [
        runner({
          id: "project-default",
          capabilityAgent: "claude",
          model: "claude-sonnet-4-6",
        }),
        runner({
          id: "platform-default",
          capabilityAgent: "claude",
          model: "claude-haiku-4-5",
        }),
        runner({
          id: "same-base",
          capabilityAgent: "claude",
          model: "claude-opus-4-8[1m]",
        }),
      ],
      project: { defaultRunnerId: "project-default" },
      platform: { defaultRunnerId: "platform-default" },
      slotKey: "session:implement",
      slot: {
        runner_type: "acp",
        capability_agent: "claude",
        model: "claude-opus-4-8",
        provider: { kind: "anthropic" },
        permission_policy: "default",
      },
    });

    expect(resolved?.runnerId).toBe("same-base");
  });

  it("uses same-capability project default before platform default", () => {
    const resolved = resolveRunnerSlot({
      ...base,
      runners: [
        runner({
          id: "platform-default",
          capabilityAgent: "claude",
          model: "claude-haiku-4-5",
        }),
        runner({
          id: "project-default",
          capabilityAgent: "claude",
          model: "claude-sonnet-4-6",
        }),
      ],
      project: { defaultRunnerId: "project-default" },
      platform: { defaultRunnerId: "platform-default" },
      slotKey: "session:implement",
      slot: {
        runner_type: "acp",
        capability_agent: "claude",
        model: "claude-opus-4-8",
        provider: { kind: "anthropic" },
        permission_policy: "default",
      },
    });

    expect(resolved).toMatchObject({
      runnerId: "project-default",
      runnerResolutionTier: "projectDefault",
      resolutionWarning: {
        launched: { runnerId: "project-default" },
      },
    });
  });

  it("skips disabled and not-ready defaults while searching fallback candidates", () => {
    const resolved = resolveRunnerSlot({
      ...base,
      runners: [
        runner({
          id: "project-default",
          capabilityAgent: "claude",
          model: "claude-sonnet-4-6",
          enabled: false,
        }),
        runner({
          id: "platform-default",
          capabilityAgent: "claude",
          model: "claude-haiku-4-5",
        }),
        runner({
          id: "not-ready-default",
          capabilityAgent: "claude",
          model: "claude-ignored",
          ready: false,
        }),
      ],
      project: { defaultRunnerId: "project-default" },
      platform: { defaultRunnerId: "platform-default" },
      slotKey: "session:implement",
      slot: {
        runner_type: "acp",
        capability_agent: "claude",
        model: "claude-opus-4-8",
        provider: { kind: "anthropic" },
        permission_policy: "default",
      },
    });

    expect(resolved).toMatchObject({
      runnerId: "platform-default",
      runnerResolutionTier: "platformDefault",
    });
  });

  it("skips defaults with the wrong capability", () => {
    expectMaisterCode(
      () =>
        resolveRunnerSlot({
          ...base,
          runners: [
            runner({
              id: "codex-default",
              capabilityAgent: "codex",
              model: "gpt-5-codex",
              providerKind: "openai",
            }),
          ],
          project: { defaultRunnerId: "codex-default" },
          platform: { defaultRunnerId: "codex-default" },
          slotKey: "session:implement",
          slot: {
            runner_type: "acp",
            capability_agent: "claude",
            model: "claude-opus-4-8",
            provider: { kind: "anthropic" },
            permission_policy: "default",
          },
        }),
      "EXECUTOR_UNAVAILABLE",
    );
  });

  it("throws when capability exists but no ranked fallback candidate remains", () => {
    expectMaisterCode(
      () =>
        resolveRunnerSlot({
          ...base,
          runners: [
            runner({
              id: "unranked-claude",
              capabilityAgent: "claude",
              model: "claude-haiku-4-5",
            }),
          ],
          project: { defaultRunnerId: null },
          platform: { defaultRunnerId: null },
          slotKey: "session:implement",
          slot: {
            runner_type: "acp",
            capability_agent: "claude",
            model: "claude-opus-4-8",
            provider: { kind: "anthropic" },
            permission_policy: "default",
          },
        }),
      "EXECUTOR_UNAVAILABLE",
    );
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
    expectMaisterCode(
      () =>
        resolveRunnerSlot({
          ...base,
          slotKey: "session:default",
          slot: {
            runner_type: "acp",
            capability_agent: "claude",
            permission_policy: "default",
          },
        }),
      "CONFIG",
    );
  });

  it("throws EXECUTOR_UNAVAILABLE when no host matches the intent", () => {
    expectMaisterCode(
      () =>
        resolveRunnerSlot({
          ...base,
          runners: [codexGpt],
          slotKey: "session:default",
          slot: {
            runner_type: "acp",
            capability_agent: "claude",
            model: "claude-haiku-4-5",
            permission_policy: "default",
          },
        }),
      "EXECUTOR_UNAVAILABLE",
    );
  });

  it("does not fall back from an explicit bad override", () => {
    expectMaisterCode(
      () =>
        resolveRunnerSlot({
          ...base,
          overrideRunnerId: "ghost",
          runners: [
            runner({
              id: "same-base",
              capabilityAgent: "claude",
              model: "claude-opus-4-8[1m]",
            }),
          ],
          slotKey: "session:default",
          slot: {
            runner_type: "acp",
            capability_agent: "claude",
            model: "claude-opus-4-8",
            permission_policy: "default",
          },
        }),
      "EXECUTOR_UNAVAILABLE",
    );
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

  it("threads warning session names through resolved sessions", () => {
    const out = resolveRunSessions(
      input({
        sessions: [
          {
            name: "review",
            runner: {
              runner_type: "acp",
              capability_agent: "claude",
              model: "claude-opus-4-8",
              provider: { kind: "anthropic" },
              permission_policy: "default",
            },
          },
        ],
        runners: [
          runner({
            id: "claude-opus-1m",
            capabilityAgent: "claude",
            model: "claude-opus-4-8[1m]",
          }),
        ],
      }),
    );

    expect(out[0]).toMatchObject({
      sessionName: "review",
      runnerId: "claude-opus-1m",
      resolutionWarning: {
        sessionName: "review",
        slotKey: "session:review",
      },
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
