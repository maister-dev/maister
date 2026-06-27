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
  runSessions,
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

  it("stores runner ids + snapshots on run_sessions (M42), not the runs row", () => {
    expect(Object.keys(projects)).toContain("defaultRunnerId");
    // M42 (ADR-114): the per-run runner mirror was dropped from `runs` and is
    // now the sole source of truth on `run_sessions`.
    expect(Object.keys(runs)).not.toContain("runnerId");
    expect(Object.keys(runs)).not.toContain("acpSessionId");
    expect(Object.keys(runSessions)).toContain("runnerId");
    expect(Object.keys(runSessions)).toContain("runnerResolutionTier");
    expect(Object.keys(runSessions)).toContain("capabilityAgent");
    expect(Object.keys(runSessions)).toContain("runnerSnapshot");
    expect(Object.keys(runSessions)).toContain("acpSessionId");
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
      env: {},
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

  it("runner inferred types accept designed Gemini, OpenCode, and MiMo adapters without a schema migration", () => {
    const geminiRunner: PlatformAcpRunner = {
      id: "gemini-cli",
      adapter: "gemini",
      capabilityAgent: "gemini",
      model: "gemini-3-pro",
      env: {},
      provider: { kind: "google_gemini", apiKey: "env:GEMINI_API_KEY" },
      permissionPolicy: "default",
      sidecarId: null,
      readinessStatus: "NotReady",
      readinessReasons: ["adapter smoke has not been verified"],
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const opencodeSnapshot: RunnerSnapshot = {
      id: "opencode-native",
      adapter: "opencode",
      capabilityAgent: "opencode",
      model: "opencode-default",
      provider: { kind: "agent_native" },
      providerKind: "agent_native",
      permissionPolicy: "default",
    };
    const mimoSnapshot: RunnerSnapshot = {
      id: "mimo-code-native",
      adapter: "mimo",
      capabilityAgent: "mimo",
      model: "mimo-native",
      provider: { kind: "agent_native" },
      providerKind: "agent_native",
      permissionPolicy: "default",
    };

    expect(geminiRunner.provider.kind).toBe("google_gemini");
    expect(opencodeSnapshot.capabilityAgent).toBe("opencode");
    expect(mimoSnapshot.capabilityAgent).toBe("mimo");
  });
});
