import type {
  AdapterLaunch,
  Executor,
  RunnerLaunch,
  StartSessionRequest,
} from "./types";

import { SupervisorError } from "./types";

type ProvisionedRunnerLaunch = {
  executor: Executor;
  adapterLaunch?: AdapterLaunch;
};

function resolveEnvRef(name: string, context: string): string {
  const value = process.env[name];

  if (!value) {
    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      `${context} env ref is not set: ${name}`,
    );
  }

  return value;
}

function mergeAdapterLaunch(
  base: AdapterLaunch | undefined,
  patch: AdapterLaunch | undefined,
): AdapterLaunch | undefined {
  const merged: AdapterLaunch = {
    ...(base?.env || patch?.env
      ? { env: { ...(base?.env ?? {}), ...(patch?.env ?? {}) } }
      : {}),
    ...(base?.preArgs || patch?.preArgs
      ? { preArgs: [...(base?.preArgs ?? []), ...(patch?.preArgs ?? [])] }
      : {}),
    ...(base?.postArgs || patch?.postArgs
      ? { postArgs: [...(base?.postArgs ?? []), ...(patch?.postArgs ?? [])] }
      : {}),
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function provisionRunnerLaunch(
  runner: RunnerLaunch,
  baseAdapterLaunch?: AdapterLaunch,
): ProvisionedRunnerLaunch {
  if (runner.adapter !== runner.capabilityAgent) {
    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      `runner ${runner.runnerId} adapter/capability mismatch is unsupported`,
    );
  }

  const executor: Executor = {
    agent: runner.adapter,
    model: runner.model,
  };
  let adapterLaunch: AdapterLaunch | undefined;

  if (runner.permissionPolicy === "dangerously_skip_permissions") {
    if (runner.adapter !== "claude") {
      throw new SupervisorError(
        "EXECUTOR_UNAVAILABLE",
        `runner ${runner.runnerId} permission policy is unsupported by ${runner.adapter}`,
      );
    }

    adapterLaunch = mergeAdapterLaunch(adapterLaunch, {
      preArgs: ["--dangerously-skip-permissions"],
    });
  }

  switch (runner.provider.kind) {
    case "anthropic":
      if (runner.adapter !== "claude") {
        throw new SupervisorError(
          "EXECUTOR_UNAVAILABLE",
          `runner ${runner.runnerId} provider anthropic requires claude adapter`,
        );
      }
      break;
    case "anthropic_compatible":
      if (runner.adapter !== "claude") {
        throw new SupervisorError(
          "EXECUTOR_UNAVAILABLE",
          `runner ${runner.runnerId} provider anthropic_compatible requires claude adapter`,
        );
      }
      executor.env = {
        ...(executor.env ?? {}),
        ...(runner.provider.baseUrl
          ? { ANTHROPIC_BASE_URL: runner.provider.baseUrl }
          : {}),
        ...(runner.provider.authTokenEnv
          ? {
              ANTHROPIC_AUTH_TOKEN: resolveEnvRef(
                runner.provider.authTokenEnv,
                `runner ${runner.runnerId} anthropic auth token`,
              ),
            }
          : {}),
      };
      break;
    case "openai":
      if (runner.adapter !== "codex") {
        throw new SupervisorError(
          "EXECUTOR_UNAVAILABLE",
          `runner ${runner.runnerId} provider openai requires codex adapter`,
        );
      }
      break;
    case "openai_compatible":
      throw new SupervisorError(
        "EXECUTOR_UNAVAILABLE",
        `runner ${runner.runnerId} provider openai_compatible requires Codex profile materialization before spawn`,
      );
  }

  if (runner.sidecar) {
    if (runner.sidecar.kind !== "ccr" || runner.adapter !== "claude") {
      throw new SupervisorError(
        "EXECUTOR_UNAVAILABLE",
        `runner ${runner.runnerId} sidecar ${runner.sidecar.kind} is unsupported by ${runner.adapter}`,
      );
    }

    executor.router = "ccr";
    if (runner.sidecar.authTokenEnv) {
      executor.env = {
        ...(executor.env ?? {}),
        ANTHROPIC_AUTH_TOKEN: resolveEnvRef(
          runner.sidecar.authTokenEnv,
          `runner ${runner.runnerId} sidecar auth token`,
        ),
      };
    }
  }

  return {
    executor,
    adapterLaunch: mergeAdapterLaunch(adapterLaunch, baseAdapterLaunch),
  };
}

export function effectiveStartSessionRequest(
  request: StartSessionRequest,
): StartSessionRequest {
  if (!request.runner) return request;

  const provisioned = provisionRunnerLaunch(request.runner, request.adapterLaunch);

  return {
    ...request,
    executor: provisioned.executor,
    adapterLaunch: provisioned.adapterLaunch,
  };
}
