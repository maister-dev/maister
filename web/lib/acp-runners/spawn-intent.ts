import "server-only";

import type { ScratchAdapterLaunch } from "@/lib/db/schema";
import type {
  SupervisorAdapterLaunchInput,
  SupervisorExecutorInput,
  SupervisorRunnerInput,
} from "@/lib/supervisor-client";
import type {
  PlatformRunnerProvider,
  RunnerSidecarSnapshot,
  RunnerSnapshot,
} from "@/lib/acp-runners/resolve";

function envRefName(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  if (!ref.startsWith("env:")) return undefined;

  return ref.slice("env:".length);
}

function nonEmptyRecord(
  values: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const entries = Object.entries(values ?? {});

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function providerFromSnapshot(
  snapshot: RunnerSnapshot,
): PlatformRunnerProvider {
  if (snapshot.provider) return snapshot.provider;

  switch (snapshot.providerKind) {
    case "anthropic":
      return { kind: "anthropic" };
    case "anthropic_compatible":
      return { kind: "anthropic_compatible" };
    case "openai":
      return { kind: "openai" };
    case "openai_compatible":
      return { kind: "openai_compatible" };
    case "google_gemini":
      return { kind: "google_gemini" };
    case "google_vertex":
      return { kind: "google_vertex" };
    case "google_gateway":
      return { kind: "google_gateway" };
    case "agent_native":
      return { kind: "agent_native" };
    default:
      if (snapshot.adapter === "claude") return { kind: "anthropic" };
      if (snapshot.adapter === "codex") return { kind: "openai" };
      if (snapshot.adapter === "gemini") return { kind: "google_gemini" };

      return { kind: "agent_native" };
  }
}

export function runnerExecutorInput(
  snapshot: RunnerSnapshot,
): SupervisorExecutorInput {
  return {
    agent: snapshot.capabilityAgent as SupervisorExecutorInput["agent"],
    model: snapshot.model,
    router: snapshot.sidecarId ? "ccr" : undefined,
  };
}

export function mergeRunnerAdapterLaunch(
  snapshot: RunnerSnapshot,
  base?: ScratchAdapterLaunch | SupervisorAdapterLaunchInput,
): SupervisorAdapterLaunchInput | undefined {
  const preArgs = [...(base?.preArgs ?? [])];

  if (
    snapshot.adapter === "claude" &&
    snapshot.permissionPolicy === "dangerously_skip_permissions"
  ) {
    preArgs.push("--dangerously-skip-permissions");
  }

  const merged: SupervisorAdapterLaunchInput = {
    ...(base?.env ? { env: base.env } : {}),
    ...(preArgs.length > 0 ? { preArgs } : {}),
    ...(base?.postArgs ? { postArgs: base.postArgs } : {}),
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function toSupervisorProvider(
  provider: PlatformRunnerProvider,
): SupervisorRunnerInput["provider"] {
  switch (provider.kind) {
    case "anthropic_compatible":
      return {
        kind: provider.kind,
        ...(envRefName(provider.authToken)
          ? { authTokenEnv: envRefName(provider.authToken) }
          : {}),
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      };
    case "openai_compatible":
      return {
        kind: provider.kind,
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
        ...(envRefName(provider.apiKey)
          ? { apiKeyEnv: envRefName(provider.apiKey) }
          : {}),
        ...(provider.wireApi ? { wireApi: provider.wireApi } : {}),
      };
    case "google_gemini":
      return {
        kind: provider.kind,
        ...(envRefName(provider.apiKey)
          ? { apiKeyEnv: envRefName(provider.apiKey) }
          : {}),
      };
    case "google_vertex":
      return {
        kind: provider.kind,
        ...(provider.projectId ? { projectId: provider.projectId } : {}),
        ...(provider.location ? { location: provider.location } : {}),
        ...(envRefName(provider.apiKey)
          ? { apiKeyEnv: envRefName(provider.apiKey) }
          : {}),
      };
    case "google_gateway":
      return {
        kind: provider.kind,
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
        ...(envRefName(provider.apiKey)
          ? { apiKeyEnv: envRefName(provider.apiKey) }
          : {}),
      };
    case "anthropic":
    case "openai":
    case "agent_native":
      return { kind: provider.kind };
  }
}

export function runnerSupervisorInput(input: {
  snapshot: RunnerSnapshot;
  provider?: PlatformRunnerProvider | null;
  sidecar?: RunnerSidecarSnapshot | null;
}): SupervisorRunnerInput {
  const provider = input.provider ?? providerFromSnapshot(input.snapshot);
  const sidecar = input.sidecar ?? input.snapshot.sidecar;
  const runnerProvider = toSupervisorProvider(provider);
  const env = nonEmptyRecord(input.snapshot.env);

  return {
    version: 1,
    runnerId: input.snapshot.id,
    adapter: input.snapshot.adapter as SupervisorRunnerInput["adapter"],
    capabilityAgent: input.snapshot
      .capabilityAgent as SupervisorRunnerInput["capabilityAgent"],
    model: input.snapshot.model,
    provider: runnerProvider,
    permissionPolicy: input.snapshot
      .permissionPolicy as SupervisorRunnerInput["permissionPolicy"],
    ...(env ? { env } : {}),
    ...(sidecar
      ? {
          sidecar: {
            id: sidecar.id,
            kind: sidecar.kind,
            ...(sidecar.lifecycle ? { lifecycle: sidecar.lifecycle } : {}),
            ...(sidecar.configPath ? { configPath: sidecar.configPath } : {}),
            ...(sidecar.baseUrl ? { baseUrl: sidecar.baseUrl } : {}),
            ...(sidecar.healthcheckUrl
              ? { healthcheckUrl: sidecar.healthcheckUrl }
              : {}),
            authTokenEnv: envRefName(sidecar.authTokenRef ?? undefined),
          },
        }
      : {}),
  };
}
