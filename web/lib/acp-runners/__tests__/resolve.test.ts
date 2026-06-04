import { describe, expect, it } from "vitest";

import {
  resolveRunner,
  type RunnerCatalogEntry,
} from "@/lib/acp-runners/resolve";
import { isMaisterError, MaisterError } from "@/lib/errors";

function runner(
  input: Omit<RunnerCatalogEntry, "permissionPolicy">,
): RunnerCatalogEntry {
  return { ...input, permissionPolicy: "default" };
}

const runners = [
  runner({
    id: "platform-default",
    adapter: "claude",
    capabilityAgent: "claude",
    model: "claude-sonnet-4-6",
    providerKind: "anthropic",
    enabled: true,
    ready: true,
  }),
  runner({
    id: "project-default",
    adapter: "codex",
    capabilityAgent: "codex",
    model: "gpt-5-codex",
    providerKind: "openai",
    enabled: true,
    ready: true,
  }),
  runner({
    id: "platform-flow",
    adapter: "claude",
    capabilityAgent: "claude",
    model: "glm-5.1",
    providerKind: "anthropic_compatible",
    enabled: true,
    ready: true,
  }),
  runner({
    id: "project-flow",
    adapter: "codex",
    capabilityAgent: "codex",
    model: "qwen3.6-plus",
    providerKind: "openai_compatible",
    enabled: true,
    ready: true,
  }),
  runner({
    id: "step-target",
    adapter: "claude",
    capabilityAgent: "claude",
    model: "claude-sonnet-4-6",
    providerKind: "anthropic",
    enabled: true,
    ready: true,
  }),
  runner({
    id: "launch-override",
    adapter: "codex",
    capabilityAgent: "codex",
    model: "gpt-5-codex",
    providerKind: "openai",
    enabled: true,
    ready: true,
  }),
] as const;

function baseInput() {
  return {
    runners: [...runners],
    platform: { defaultRunnerId: "platform-default" },
    project: { defaultRunnerId: null },
    platformFlow: { defaultRunnerId: null },
    projectFlow: { defaultRunnerId: null },
    step: { runnerId: null },
  };
}

describe("resolveRunner", () => {
  it("chooses launch override before step target, project flow, platform flow, project default, and platform default", () => {
    const result = resolveRunner({
      ...baseInput(),
      launchOverrideRunnerId: "launch-override",
      step: { runnerId: "step-target" },
      projectFlow: { defaultRunnerId: "project-flow" },
      platformFlow: { defaultRunnerId: "platform-flow" },
      project: { defaultRunnerId: "project-default" },
    });

    expect(result).toEqual({
      runnerId: "launch-override",
      runnerResolutionTier: "launchOverride",
      capabilityAgent: "codex",
      runnerSnapshot: {
        id: "launch-override",
        adapter: "codex",
        capabilityAgent: "codex",
        model: "gpt-5-codex",
        providerKind: "openai",
        permissionPolicy: "default",
      },
    });
  });

  it("falls through in the corrected order when higher tiers are absent", () => {
    expect(
      resolveRunner({
        ...baseInput(),
        step: { runnerId: "step-target" },
        projectFlow: { defaultRunnerId: "project-flow" },
      }).runnerResolutionTier,
    ).toBe("stepTarget");

    expect(
      resolveRunner({
        ...baseInput(),
        projectFlow: { defaultRunnerId: "project-flow" },
        platformFlow: { defaultRunnerId: "platform-flow" },
      }).runnerResolutionTier,
    ).toBe("projectFlowDefault");

    expect(
      resolveRunner({
        ...baseInput(),
        platformFlow: { defaultRunnerId: "platform-flow" },
        project: { defaultRunnerId: "project-default" },
      }).runnerResolutionTier,
    ).toBe("platformFlowDefault");

    expect(
      resolveRunner({
        ...baseInput(),
        project: { defaultRunnerId: "project-default" },
      }).runnerResolutionTier,
    ).toBe("projectDefault");

    expect(resolveRunner(baseInput()).runnerResolutionTier).toBe(
      "platformDefault",
    );
  });

  it("refuses missing referenced runner ids without falling back", () => {
    let caught: unknown;

    try {
      resolveRunner({
        ...baseInput(),
        step: { runnerId: "missing-step-runner" },
        project: { defaultRunnerId: "project-default" },
      });
    } catch (err) {
      caught = err;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as MaisterError).code).toBe("EXECUTOR_UNAVAILABLE");
    expect((caught as MaisterError).message).toMatch(/missing-step-runner/);
    expect((caught as MaisterError).message).toMatch(/stepTarget/);
  });

  it("refuses disabled or not-ready runners before lower tiers", () => {
    let caught: unknown;

    try {
      resolveRunner({
        ...baseInput(),
        launchOverrideRunnerId: "disabled-runner",
        runners: [
          ...runners,
          {
            id: "disabled-runner",
            adapter: "claude",
            capabilityAgent: "claude",
            model: "claude-sonnet-4-6",
            providerKind: "anthropic",
            permissionPolicy: "default",
            enabled: false,
            ready: true,
          },
        ],
        project: { defaultRunnerId: "project-default" },
      });
    } catch (err) {
      caught = err;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as MaisterError).code).toBe("EXECUTOR_UNAVAILABLE");
    expect((caught as MaisterError).message).toMatch(/disabled-runner/);
    expect((caught as MaisterError).message).toMatch(/disabled/);
  });
});
