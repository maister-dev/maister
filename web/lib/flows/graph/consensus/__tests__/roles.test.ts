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
