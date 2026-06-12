import { describe, expect, it } from "vitest";

import {
  resolveAgentRunner,
  type AgentRunnerResolutionInput,
  type RunnerCatalogEntry,
} from "@/lib/acp-runners/resolve";
import { isMaisterError } from "@/lib/errors";

function entry(
  id: string,
  overrides: Partial<RunnerCatalogEntry> = {},
): RunnerCatalogEntry {
  return {
    id,
    adapter: "claude",
    capabilityAgent: "claude",
    model: "claude-sonnet-4-6",
    providerKind: "anthropic",
    permissionPolicy: "default",
    enabled: true,
    ready: true,
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<AgentRunnerResolutionInput> = {},
): AgentRunnerResolutionInput {
  return {
    link: { runnerOverrideId: null },
    agent: { runnerId: null, mode: "session", workspace: "none" },
    project: { defaultRunnerId: null },
    platform: { defaultRunnerId: "platform-r" },
    runners: [
      entry("launch-r"),
      entry("link-r"),
      entry("agent-r"),
      entry("project-r"),
      entry("platform-r"),
    ],
    ...overrides,
  };
}

function expectUnavailable(fn: () => unknown, match: RegExp): void {
  try {
    fn();
    expect.unreachable("expected EXECUTOR_UNAVAILABLE");
  } catch (err) {
    expect(isMaisterError(err)).toBe(true);
    if (isMaisterError(err)) {
      expect(err.code).toBe("EXECUTOR_UNAVAILABLE");
      expect(err.message).toMatch(match);
    }
  }
}

describe("resolveAgentRunner — standalone chain precedence", () => {
  it("launch override wins over every other tier", () => {
    const resolution = resolveAgentRunner(
      baseInput({
        launchOverrideRunnerId: "launch-r",
        link: { runnerOverrideId: "link-r" },
        agent: { runnerId: "agent-r", mode: "session", workspace: "none" },
        project: { defaultRunnerId: "project-r" },
      }),
    );

    expect(resolution.runnerId).toBe("launch-r");
    expect(resolution.runnerResolutionTier).toBe("launchOverride");
  });

  it("link override beats the agent default; agent default beats project/platform", () => {
    const viaLink = resolveAgentRunner(
      baseInput({
        link: { runnerOverrideId: "link-r" },
        agent: { runnerId: "agent-r", mode: "session", workspace: "none" },
      }),
    );

    expect(viaLink.runnerResolutionTier).toBe("agentLinkOverride");

    const viaAgent = resolveAgentRunner(
      baseInput({
        agent: { runnerId: "agent-r", mode: "session", workspace: "none" },
        project: { defaultRunnerId: "project-r" },
      }),
    );

    expect(viaAgent.runnerId).toBe("agent-r");
    expect(viaAgent.runnerResolutionTier).toBe("agentDefault");
  });

  it("falls to project then platform defaults and snapshots the winner", () => {
    const viaProject = resolveAgentRunner(
      baseInput({ project: { defaultRunnerId: "project-r" } }),
    );

    expect(viaProject.runnerResolutionTier).toBe("projectDefault");

    const viaPlatform = resolveAgentRunner(baseInput());

    expect(viaPlatform.runnerId).toBe("platform-r");
    expect(viaPlatform.runnerResolutionTier).toBe("platformDefault");
    expect(viaPlatform.runnerSnapshot).toMatchObject({
      id: "platform-r",
      capabilityAgent: "claude",
      permissionPolicy: "default",
    });
  });

  it("a named tier never falls through: disabled/missing/not-ready refuse", () => {
    expectUnavailable(
      () =>
        resolveAgentRunner(
          baseInput({
            launchOverrideRunnerId: "ghost",
          }),
        ),
      /missing; refusing fallback/,
    );
    expectUnavailable(
      () =>
        resolveAgentRunner(
          baseInput({
            launchOverrideRunnerId: "launch-r",
            runners: [entry("launch-r", { enabled: false })],
          }),
        ),
      /disabled; refusing fallback/,
    );
    expectUnavailable(
      () =>
        resolveAgentRunner(
          baseInput({
            launchOverrideRunnerId: "launch-r",
            runners: [entry("launch-r", { ready: false })],
          }),
        ),
      /not ready; refusing fallback/,
    );
  });
});

describe("resolveAgentRunner — compatibility refusals (ADR-087/088)", () => {
  it("refuses a subagent-mode definition on a non-claude capability runner", () => {
    expectUnavailable(
      () =>
        resolveAgentRunner(
          baseInput({
            launchOverrideRunnerId: "codex-r",
            agent: { runnerId: null, mode: "subagent", workspace: "worktree" },
            runners: [
              entry("codex-r", { adapter: "codex", capabilityAgent: "codex" }),
            ],
          }),
        ),
      /cannot host a subagent-mode definition/,
    );
  });

  it("refuses none/repo_read agents on dangerously_skip_permissions runners", () => {
    for (const workspace of ["none", "repo_read"] as const) {
      expectUnavailable(
        () =>
          resolveAgentRunner(
            baseInput({
              launchOverrideRunnerId: "skip-r",
              agent: { runnerId: null, mode: "session", workspace },
              runners: [
                entry("skip-r", {
                  permissionPolicy: "dangerously_skip_permissions",
                }),
              ],
            }),
          ),
        /dangerously_skip_permissions/,
      );
    }

    // worktree agents keep their writes inside the worktree — allowed.
    const resolution = resolveAgentRunner(
      baseInput({
        launchOverrideRunnerId: "skip-r",
        agent: { runnerId: null, mode: "session", workspace: "worktree" },
        runners: [
          entry("skip-r", {
            permissionPolicy: "dangerously_skip_permissions",
          }),
        ],
      }),
    );

    expect(resolution.runnerId).toBe("skip-r");
  });
});
