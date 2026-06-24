import { describe, expect, it, vi } from "vitest";

const resolveAgentLaunchRuntime = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agents/launch", () => ({ resolveAgentLaunchRuntime }));

import {
  resolveConsensusRoleRuntime,
  resolveConsensusRunnerSnapshot,
} from "@/lib/flows/graph/consensus/roles";

function dbWithSelectRows(rows: unknown[][]): unknown {
  const queue = [...rows];

  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => queue.shift() ?? []),
      })),
    })),
  };
}

describe("consensus role resolution", () => {
  it("preserves runner provider and sidecar launch snapshot", async () => {
    const db = dbWithSelectRows([
      [
        {
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
          permissionPolicy: "default",
          sidecarId: "sidecar-1",
          readinessStatus: "Ready",
          enabled: true,
        },
      ],
      [
        {
          id: "sidecar-1",
          kind: "ccr",
          lifecycle: "managed",
          configPath: "/tmp/ccr.json",
          baseUrl: "http://ccr.local",
          healthcheckUrl: "http://ccr.local/health",
          authTokenRef: "env:CCR_TOKEN",
        },
      ],
    ]);

    const snapshot = await resolveConsensusRunnerSnapshot({
      db,
      runnerId: "runner-ccr",
      roleLabel: "consensus participant",
    });

    expect(snapshot).toEqual(
      expect.objectContaining({
        id: "runner-ccr",
        providerKind: "anthropic_compatible",
        sidecarId: "sidecar-1",
        sidecar: expect.objectContaining({
          id: "sidecar-1",
          kind: "ccr",
          baseUrl: "http://ccr.local",
        }),
      }),
    );
  });

  it("fails fast when a runner references a missing sidecar", async () => {
    const db = dbWithSelectRows([
      [
        {
          id: "runner-ccr",
          adapter: "claude",
          capabilityAgent: "claude",
          model: "sonnet",
          provider: { kind: "anthropic_compatible" },
          permissionPolicy: "default",
          sidecarId: "missing-sidecar",
          readinessStatus: "Ready",
          enabled: true,
        },
      ],
      [],
    ]);

    await expect(
      resolveConsensusRunnerSnapshot({
        db,
        runnerId: "runner-ccr",
        roleLabel: "consensus participant",
      }),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
  });

  it("resolves agent roles through the standard agent launch runtime", async () => {
    const db = dbWithSelectRows([]);

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
      db,
      projectId: "project-1",
      taskId: "task-1",
      role: { agent: "agent-architect" },
      roleLabel: "consensus verifier participant",
    });

    expect(resolveAgentLaunchRuntime).toHaveBeenCalledWith({
      agentId: "agent-architect",
      projectId: "project-1",
      taskId: "task-1",
      trigger: { source: "flow" },
      db,
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
