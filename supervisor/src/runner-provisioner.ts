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

function requireAdapter(
  actual: RunnerLaunch["adapter"],
  expected: RunnerLaunch["adapter"],
  context: string,
): void {
  if (actual !== expected) {
    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      `${context} requires ${expected} adapter`,
    );
  }
}

function requireAgentNativeAdapter(
  actual: RunnerLaunch["adapter"],
  context: string,
): void {
  if (actual === "opencode" || actual === "mimo") return;

  throw new SupervisorError(
    "EXECUTOR_UNAVAILABLE",
    `${context} requires opencode or mimo adapter`,
  );
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
      requireAdapter(
        runner.adapter,
        "claude",
        `runner ${runner.runnerId} provider anthropic`,
      );
      break;
    case "anthropic_compatible":
      requireAdapter(
        runner.adapter,
        "claude",
        `runner ${runner.runnerId} provider anthropic_compatible`,
      );
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
      requireAdapter(
        runner.adapter,
        "codex",
        `runner ${runner.runnerId} provider openai`,
      );
      break;
    case "openai_compatible":
      throw new SupervisorError(
        "EXECUTOR_UNAVAILABLE",
        `runner ${runner.runnerId} provider openai_compatible requires Codex profile materialization before spawn`,
      );
    case "google_gemini":
      requireAdapter(
        runner.adapter,
        "gemini",
        `runner ${runner.runnerId} provider google_gemini`,
      );
      if (runner.provider.apiKeyEnv) {
        executor.env = {
          ...(executor.env ?? {}),
          GEMINI_API_KEY: resolveEnvRef(
            runner.provider.apiKeyEnv,
            `runner ${runner.runnerId} Gemini API key`,
          ),
        };
      }
      break;
    case "google_vertex":
      requireAdapter(
        runner.adapter,
        "gemini",
        `runner ${runner.runnerId} provider google_vertex`,
      );
      if (
        !runner.provider.apiKeyEnv &&
        (!runner.provider.projectId || !runner.provider.location)
      ) {
        throw new SupervisorError(
          "EXECUTOR_UNAVAILABLE",
          `runner ${runner.runnerId} provider google_vertex requires either apiKeyEnv or projectId and location`,
        );
      }
      executor.env = {
        ...(executor.env ?? {}),
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        ...(runner.provider.projectId
          ? { GOOGLE_CLOUD_PROJECT: runner.provider.projectId }
          : {}),
        ...(runner.provider.location
          ? { GOOGLE_CLOUD_LOCATION: runner.provider.location }
          : {}),
        ...(runner.provider.apiKeyEnv
          ? {
              GOOGLE_API_KEY: resolveEnvRef(
                runner.provider.apiKeyEnv,
                `runner ${runner.runnerId} Vertex API key`,
              ),
            }
          : {}),
      };
      break;
    case "google_gateway":
      requireAdapter(
        runner.adapter,
        "gemini",
        `runner ${runner.runnerId} provider google_gateway`,
      );
      if (!runner.provider.baseUrl || !runner.provider.apiKeyEnv) {
        throw new SupervisorError(
          "EXECUTOR_UNAVAILABLE",
          `runner ${runner.runnerId} provider google_gateway requires baseUrl and apiKeyEnv`,
        );
      }
      executor.env = {
        ...(executor.env ?? {}),
        GOOGLE_GEMINI_BASE_URL: runner.provider.baseUrl,
        GEMINI_API_KEY: resolveEnvRef(
          runner.provider.apiKeyEnv,
          `runner ${runner.runnerId} Gemini gateway API key`,
        ),
      };
      break;
    case "agent_native":
      requireAgentNativeAdapter(
        runner.adapter,
        `runner ${runner.runnerId} provider agent_native`,
      );
      break;
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

  const provisioned = provisionRunnerLaunch(
    request.runner,
    request.adapterLaunch,
  );

  return {
    ...request,
    executor: provisioned.executor,
    adapterLaunch: provisioned.adapterLaunch,
  };
}
