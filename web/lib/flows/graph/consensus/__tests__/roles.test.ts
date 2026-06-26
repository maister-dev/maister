import type { RunnerCatalogEntry } from "@/lib/acp-runners/resolve";

import { describe, expect, it, vi } from "vitest";

const resolveAgentLaunchRuntime = vi.hoisted(() => vi.fn());
const loadRunnerCatalog = vi.hoisted(() => vi.fn());
const loadFlowRunnerBindings = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agents/launch", () => ({ resolveAgentLaunchRuntime }));
vi.mock("@/lib/acp-runners/catalog", () => ({
  loadRunnerCatalog,
  loadFlowRunnerBindings,
}));

import {
  resolveConsensusRoleRuntime,
  resolveConsensusRunnerSlot,
} from "@/lib/flows/graph/consensus/roles";

const ccrRunner: RunnerCatalogEntry = {
  id: "runner-ccr",
  adapter: "claude",
  capabilityAgent: "claude",
  model: "sonnet",
  env: { ANTHROPIC_BASE_URL: "http://ccr.local" },
  provider: {
    kind: "anthropic_compatible",
    baseUrl: "http://ccr.local",
    authToken: "env:ANTHROPIC_API_KEY",
  },
  providerKind: "anthropic_compatible",
  permissionPolicy: "default",
  sidecar: {
    id: "sidecar-1",
    kind: "ccr",
    lifecycle: "managed",
    configPath: "/tmp/ccr.json",
    baseUrl: "http://ccr.local",
    healthcheckUrl: "http://ccr.local/health",
    authTokenRef: "env:CCR_TOKEN",
  },
  sidecarId: "sidecar-1",
  enabled: true,
  ready: true,
};

describe("consensus role resolution", () => {
  it("resolves a bound runner slot and preserves its provider + sidecar snapshot", async () => {
    loadRunnerCatalog.mockResolvedValue([ccrRunner]);
    loadFlowRunnerBindings.mockResolvedValue([
      {
        slotKey: "consensus:gate:p1",
        mappedRunnerId: "runner-ccr",
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
      runnerId: "runner-ccr",
      runnerResolutionTier: "binding",
      runnerSnapshot: expect.objectContaining({
        id: "runner-ccr",
        providerKind: "anthropic_compatible",
        sidecarId: "sidecar-1",
        sidecar: expect.objectContaining({ id: "sidecar-1", kind: "ccr" }),
      }),
    });
  });

  it("auto-matches a unique host runner by intent when no binding exists", async () => {
    loadRunnerCatalog.mockResolvedValue([ccrRunner]);
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
    expect(resolved.runnerId).toBe("runner-ccr");
  });

  it("fails when no host runner matches the slot intent", async () => {
    loadRunnerCatalog.mockResolvedValue([ccrRunner]);
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
