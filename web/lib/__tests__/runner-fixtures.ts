import type { RunnerSnapshot } from "@/lib/db/schema";

export type TestRunnerAgent = "claude" | "codex";

export function testRunnerSnapshot(
  id: string,
  agent: TestRunnerAgent = "claude",
): RunnerSnapshot {
  const model = agent === "claude" ? "claude-sonnet-4-6" : "gpt-5-codex";
  const providerKind = agent === "claude" ? "anthropic" : "openai";

  return {
    id,
    adapter: agent,
    capabilityAgent: agent,
    model,
    provider: { kind: providerKind },
    providerKind,
    permissionPolicy: "default",
    sidecar: null,
    sidecarId: null,
  };
}

export function testPlatformRunnerRow(
  id: string,
  agent: TestRunnerAgent = "claude",
): Record<string, unknown> {
  const snapshot = testRunnerSnapshot(id, agent);

  return {
    id,
    adapter: snapshot.adapter,
    capabilityAgent: snapshot.capabilityAgent,
    model: snapshot.model,
    provider: snapshot.provider,
    permissionPolicy: snapshot.permissionPolicy,
    readinessStatus: "Ready",
    readinessReasons: [],
    enabled: true,
  };
}
