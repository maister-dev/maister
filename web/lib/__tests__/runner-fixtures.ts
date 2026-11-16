import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type {
  PlatformRunnerProvider,
  RunnerSnapshot,
  platformAcpRunners,
} from "@/lib/db/schema";

export type TestRunnerAgent = AdapterId;

function testRunnerModel(agent: TestRunnerAgent): string {
  switch (agent) {
    case "claude":
      return "claude-sonnet-4-6";
    case "codex":
      return "gpt-5-codex";
    case "gemini":
      return "gemini-3-pro";
    case "opencode":
      return "opencode-default";
    case "mimo":
      return "mimo-native";
  }
}

function testRunnerProvider(agent: TestRunnerAgent): PlatformRunnerProvider {
  switch (agent) {
    case "claude":
      return { kind: "anthropic" };
    case "codex":
      return { kind: "openai" };
    case "gemini":
      return { kind: "google_gemini", apiKey: "env:GEMINI_API_KEY" };
    case "opencode":
    case "mimo":
      return { kind: "agent_native" };
  }
}

export function testRunnerSnapshot(
  id: string,
  agent: TestRunnerAgent = "claude",
): RunnerSnapshot {
  const model = testRunnerModel(agent);
  const provider = testRunnerProvider(agent);
  const providerKind = provider.kind;

  return {
    id,
    adapter: agent,
    capabilityAgent: agent,
    model,
    provider,
    providerKind,
    permissionPolicy: "default",
  };
}

export function testPlatformRunnerRow(
  id: string,
  agent: TestRunnerAgent = "claude",
): typeof platformAcpRunners.$inferInsert {
  return {
    id,
    adapter: agent,
    capabilityAgent: agent,
    model: testRunnerModel(agent),
    provider: testRunnerProvider(agent),
    permissionPolicy: "default",
    readinessStatus: "Ready",
    readinessReasons: [],
    enabled: true,
  };
}
