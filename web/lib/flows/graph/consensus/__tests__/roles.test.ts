import type { RunnerCatalogEntry } from "@/lib/acp-runners/resolve";

import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveAgentLaunchRuntime = vi.hoisted(() => vi.fn());
const loadRunnerCatalog = vi.hoisted(() => vi.fn());
const loadFlowRunnerBindings = vi.hoisted(() => vi.fn());
const loadProjectPlatformRunnerDefaults = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agents/launch", () => ({ resolveAgentLaunchRuntime }));
vi.mock("@/lib/acp-runners/catalog", () => ({
  loadRunnerCatalog,
  loadFlowRunnerBindings,
  loadProjectPlatformRunnerDefaults,
}));

import {
  resolveConsensusRoleRuntime,
  resolveConsensusRunnerSlot,
} from "@/lib/flows/graph/consensus/roles";

const envRunner: RunnerCatalogEntry = {
  id: "runner-env",
  adapter: "claude",
  capabilityAgent: "claude",
  model: "sonnet",
  env: { ANTHROPIC_BASE_URL: "http://router.local" },
  provider: {
    kind: "anthropic_compatible",
    baseUrl: "http://router.local",
    authToken: "env:ANTHROPIC_API_KEY",
  },
  providerKind: "anthropic_compatible",
  permissionPolicy: "default",
  enabled: true,
  ready: true,
};

const instanceRunners: RunnerCatalogEntry[] = [
  ["claude-code", "claude", "opus[1m]"],
  ["claude-code-glm", "claude", "opus"],
  ["claude-fable", "claude", "claude-fable-5-1[1m]"],
  ["codex-openai", "codex", "gpt-5.6-terra"],
  ["codex-sol", "codex", "gpt-5.6-sol"],
  ["codex-astra", "codex", "gpt-6-astra"],
].map(([id, capabilityAgent, model]) => ({
  id,
  adapter: capabilityAgent,
  capabilityAgent,
  model,
  providerKind: capabilityAgent === "claude" ? "anthropic" : "openai",
  permissionPolicy: "default",
  enabled: true,
  ready: true,
}));

describe("consensus role resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadProjectPlatformRunnerDefaults.mockResolvedValue({
      project: { defaultRunnerId: null },
      platform: { defaultRunnerId: null },
    });
  });

  it("resolves a bound runner slot and preserves its provider snapshot", async () => {
    loadRunnerCatalog.mockResolvedValue([envRunner]);
    loadFlowRunnerBindings.mockResolvedValue([
      {
        slotKey: "consensus:gate:p1",
        mappedRunnerId: "runner-env",
        status: "Mapped",
      },
    ]);

    const resolved = await resolveConsensusRunnerSlot({
      db: {} as never,
      slot: {
        runner_type: "acp",
        capability_agent: "claude",
        permission_policy: "default",
      },
      slotKey: "consensus:gate:p1",
      projectId: "project-1",
      flowRevisionId: "rev-1",
      runDefaultRunnerId: null,
      runnerProfiles: undefined,
      roleLabel: 'consensus participant "p1"',
    });

    expect(resolved).toMatchObject({
      runnerId: "runner-env",
      runnerResolutionTier: "binding",
      runnerSnapshot: expect.objectContaining({
        id: "runner-env",
        providerKind: "anthropic_compatible",
      }),
    });
  });

  it("auto-matches a unique host runner by intent when no binding exists", async () => {
    loadRunnerCatalog.mockResolvedValue([envRunner]);
    loadFlowRunnerBindings.mockResolvedValue([]);

    const resolved = await resolveConsensusRunnerSlot({
      db: {} as never,
      slot: {
        runner_type: "acp",
        capability_agent: "claude",
        model: "sonnet",
        permission_policy: "default",
      },
      slotKey: "consensus:gate:synthesizer",
      projectId: "project-1",
      flowRevisionId: "rev-1",
      runDefaultRunnerId: null,
      runnerProfiles: undefined,
      roleLabel: "consensus synthesizer",
    });

    expect(resolved.runnerResolutionTier).toBe("autoMatch");
    expect(resolved.runnerId).toBe("runner-env");
  });

  it("uses project/platform defaults for soft mismatch fallback", async () => {
    loadRunnerCatalog.mockResolvedValue([
      { ...envRunner, id: "runner-platform", model: "haiku" },
      { ...envRunner, id: "runner-project", model: "sonnet-alt" },
    ]);
    loadFlowRunnerBindings.mockResolvedValue([]);
    loadProjectPlatformRunnerDefaults.mockResolvedValue({
      project: { defaultRunnerId: "runner-project" },
      platform: { defaultRunnerId: "runner-platform" },
    });

    const resolved = await resolveConsensusRunnerSlot({
      db: {} as never,
      slot: {
        runner_type: "acp",
        capability_agent: "claude",
        model: "opus",
        permission_policy: "default",
      },
      slotKey: "consensus:gate:synthesizer",
      projectId: "project-1",
      flowRevisionId: "rev-1",
      runDefaultRunnerId: null,
      runnerProfiles: undefined,
      roleLabel: "consensus synthesizer",
    });

    expect(resolved).toMatchObject({
      runnerId: "runner-project",
      runnerResolutionTier: "projectDefault",
      resolutionWarning: {
        code: "runner_intent_soft_mismatch",
        slotKey: "consensus:gate:synthesizer",
      },
    });
  });

  it.each([
    {
      capability: "codex" as const,
      runDefaultRunnerId: "codex-astra",
      projectDefaultRunnerId: "codex-openai",
      platformDefaultRunnerId: "codex-sol",
      runnerId: "codex-astra",
      tier: "runDefault",
    },
    {
      capability: "claude" as const,
      runDefaultRunnerId: "codex-astra",
      projectDefaultRunnerId: "claude-code",
      platformDefaultRunnerId: "claude-fable",
      runnerId: "claude-code",
      tier: "projectDefault",
    },
    {
      capability: "codex" as const,
      runDefaultRunnerId: "claude-code",
      projectDefaultRunnerId: "claude-fable",
      platformDefaultRunnerId: "codex-openai",
      runnerId: "codex-openai",
      tier: "platformDefault",
    },
  ])(
    "resolves ambiguous consensus intent through $tier within its capability",
    async (testCase) => {
      loadRunnerCatalog.mockResolvedValue(instanceRunners);
      loadFlowRunnerBindings.mockResolvedValue([]);
      loadProjectPlatformRunnerDefaults.mockResolvedValue({
        project: { defaultRunnerId: testCase.projectDefaultRunnerId },
        platform: { defaultRunnerId: testCase.platformDefaultRunnerId },
      });

      const resolved = await resolveConsensusRunnerSlot({
        db: {} as never,
        slot: "participant",
        slotKey: "consensus:plan_consensus:participant-draft",
        projectId: "project-1",
        flowRevisionId: "rev-1",
        runDefaultRunnerId: testCase.runDefaultRunnerId,
        runnerProfiles: {
          participant: {
            runner_type: "acp",
            capability_agent: testCase.capability,
            effort: "high",
            permission_policy: "default",
          },
        },
        roleLabel: 'consensus participant "participant-draft"',
      });

      expect(resolved).toMatchObject({
        runnerId: testCase.runnerId,
        runnerResolutionTier: testCase.tier,
        capabilityAgent: testCase.capability,
      });
    },
  );

  it("fails when no host runner matches the slot intent", async () => {
    loadRunnerCatalog.mockResolvedValue([envRunner]);
    loadFlowRunnerBindings.mockResolvedValue([]);

    await expect(
      resolveConsensusRunnerSlot({
        db: {} as never,
        slot: {
          runner_type: "acp",
          capability_agent: "codex",
          permission_policy: "default",
        },
        slotKey: "consensus:gate:p1",
        projectId: "project-1",
        flowRevisionId: "rev-1",
        runDefaultRunnerId: null,
        runnerProfiles: undefined,
        roleLabel: 'consensus participant "p1"',
      }),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
  });

  it("resolves agent roles through the standard agent launch runtime", async () => {
    resolveAgentLaunchRuntime.mockResolvedValue({
      agent: { id: "agent-architect" },
      parsed: {},
      project: { id: "project-1" },
      resolution: {
        runnerSnapshot: {
          id: "runner-agent-default",
          adapter: "claude",
          capabilityAgent: "claude",
          model: "sonnet",
          providerKind: "anthropic",
          permissionPolicy: "default",
        },
      },
    });

    const runtime = await resolveConsensusRoleRuntime({
      db: {} as never,
      projectId: "project-1",
      taskId: "task-1",
      flowRevisionId: "rev-1",
      runDefaultRunnerId: null,
      runnerProfiles: undefined,
      slotKey: "consensus:gate:p1",
      role: { agent: "agent-architect" },
      roleLabel: "consensus verifier participant",
    });

    expect(resolveAgentLaunchRuntime).toHaveBeenCalledWith({
      agentId: "agent-architect",
      projectId: "project-1",
      taskId: "task-1",
      trigger: { source: "flow" },
      db: {},
    });
    expect(runtime).toEqual(
      expect.objectContaining({
        roleKind: "agent",
        roleRef: "agent-architect",
        agentBinding: { id: "agent-architect" },
        executor: expect.objectContaining({ id: "runner-agent-default" }),
      }),
    );
  });
});
