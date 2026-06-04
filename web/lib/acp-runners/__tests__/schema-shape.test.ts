import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  flowRunnerRemaps,
  platformAcpRunners,
  platformRouterSidecars,
  platformRuntimeSettings,
  projectFlowRunnerDefaults,
  projects,
  runs,
  tasks,
  type PlatformAcpRunner,
  type RunnerSnapshot,
} from "@/lib/db/schema";

describe("platform runner persistence schema shape", () => {
  it("defines platform runner, sidecar, default, project-flow, and remap tables", () => {
    expect(getTableName(platformAcpRunners)).toBe("platform_acp_runners");
    expect(getTableName(platformRouterSidecars)).toBe(
      "platform_router_sidecars",
    );
    expect(getTableName(platformRuntimeSettings)).toBe(
      "platform_runtime_settings",
    );
    expect(getTableName(projectFlowRunnerDefaults)).toBe(
      "project_flow_runner_defaults",
    );
    expect(getTableName(flowRunnerRemaps)).toBe("flow_runner_remaps");
  });

  it("stores runner ids and snapshots on projects and runs", () => {
    expect(Object.keys(projects)).toContain("defaultRunnerId");
    expect(Object.keys(runs)).toContain("runnerId");
    expect(Object.keys(runs)).toContain("runnerResolutionTier");
    expect(Object.keys(runs)).toContain("capabilityAgent");
    expect(Object.keys(runs)).toContain("runnerSnapshot");
  });

  it("does not keep task-level runner overrides in the schema", () => {
    expect(Object.keys(tasks)).not.toContain("executorOverrideId");
  });

  it("runner inferred types expose safe launch fields without raw secrets", () => {
    const runner: PlatformAcpRunner = {
      id: "claude-code",
      adapter: "claude",
      capabilityAgent: "claude",
      model: "claude-sonnet-4-6",
      provider: { kind: "anthropic" },
      permissionPolicy: "default",
      sidecarId: null,
      readinessStatus: "Ready",
      readinessReasons: [],
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const snapshot: RunnerSnapshot = {
      id: runner.id,
      adapter: runner.adapter,
      capabilityAgent: runner.capabilityAgent,
      model: runner.model,
      providerKind: "anthropic",
      permissionPolicy: runner.permissionPolicy,
    };

    expect(snapshot.capabilityAgent).toBe("claude");
  });
});
