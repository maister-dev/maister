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
    default:
      return snapshot.adapter === "claude"
        ? { kind: "anthropic" }
        : { kind: "openai" };
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

export function runnerSupervisorInput(input: {
  snapshot: RunnerSnapshot;
  provider?: PlatformRunnerProvider | null;
  sidecar?: RunnerSidecarSnapshot | null;
}): SupervisorRunnerInput {
  const provider = input.provider ?? providerFromSnapshot(input.snapshot);
  const sidecar = input.sidecar ?? input.snapshot.sidecar;
  const runnerProvider: SupervisorRunnerInput["provider"] =
    provider.kind === "anthropic_compatible"
      ? {
          kind: provider.kind,
          authTokenEnv: envRefName(provider.authToken),
          baseUrl: provider.baseUrl,
        }
      : provider.kind === "openai_compatible"
        ? {
            kind: provider.kind,
            baseUrl: provider.baseUrl,
            apiKeyEnv: envRefName(provider.apiKey),
            wireApi: provider.wireApi,
          }
        : { kind: provider.kind };

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
