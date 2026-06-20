import "server-only";

import type { PlatformRunnerProvider } from "@/lib/db/schema";

import {
  getAdapterSupport,
  type AdapterId,
  type PermissionPolicy,
  type ProviderKind,
} from "@/lib/acp-runners/adapter-support";

type RunnerReadinessInput = {
  readonly adapter: AdapterId;
  readonly capabilityAgent: AdapterId;
  readonly enabled: boolean;
  readonly permissionPolicy: PermissionPolicy;
  readonly provider: PlatformRunnerProvider;
  readonly sidecarId?: string | null;
};

type DiagnosticsInput = {
  readonly adapters?: readonly {
    readonly id: AdapterId;
    readonly available: boolean;
    readonly smoke?: {
      readonly status: "not_required" | "pending" | "ok" | "skipped" | "error";
      readonly reason: string | null;
      readonly checkedAt: string | null;
      readonly protocolVersion: number | null;
    };
  }[];
  readonly envRefs?: readonly {
    readonly name: string;
    readonly present: boolean;
  }[];
  readonly sidecars?: readonly {
    readonly id: string;
    readonly state: string;
  }[];
};

type SidecarInput = {
  readonly id: string;
  readonly enabled: boolean;
  readonly readinessStatus: "Unknown" | "Ready" | "NotReady";
};

type RouterSidecarReadinessInput = {
  readonly id: string;
  readonly kind: "ccr";
  readonly lifecycle: "managed" | "external";
  readonly commandPreset?: "ccr_start" | null;
  readonly configPath?: string | null;
  readonly baseUrl?: string | null;
  readonly healthcheckUrl?: string | null;
  readonly enabled: boolean;
};

export type RunnerReadinessResult = {
  readonly status: "Ready" | "NotReady";
  readonly reasons: string[];
};

export type SidecarReadinessResult = {
  readonly status: "Ready" | "NotReady";
  readonly reasons: string[];
};

function envRefName(ref: string | undefined): string | null {
  if (!ref?.startsWith("env:")) return null;

  return ref.slice("env:".length);
}

function adapterSupportsProvider(
  providerKinds: readonly ProviderKind[],
  providerKind: ProviderKind,
): boolean {
  return providerKinds.includes(providerKind);
}

function adapterSupportsPermissionPolicy(
  permissionPolicies: readonly PermissionPolicy[],
  permissionPolicy: PermissionPolicy,
): boolean {
  return permissionPolicies.includes(permissionPolicy);
}

function pushMissingEnvReason(
  reasons: string[],
  diagnostics: DiagnosticsInput | undefined,
  envRef: string | null,
): void {
  if (!envRef) return;

  if (!diagnostics?.envRefs) {
    reasons.push(`env diagnostics are unavailable for: ${envRef}`);

    return;
  }

  const ref = diagnostics.envRefs.find((item) => item.name === envRef);

  if (!ref?.present) {
    reasons.push(`env ref is missing: ${envRef}`);
  }
}

export function evaluateRunnerReadiness(args: {
  readonly runner: RunnerReadinessInput;
  readonly diagnostics?: DiagnosticsInput | null;
  readonly sidecar?: SidecarInput | null;
}): RunnerReadinessResult {
  const reasons: string[] = [];
  const adapter = getAdapterSupport().find(
    (item) => item.id === args.runner.adapter,
  );

  if (!args.runner.enabled) {
    reasons.push("runner is disabled");
  }
  if (!adapter) {
    reasons.push(`adapter is unsupported: ${args.runner.adapter}`);
  } else {
    if (adapter.capabilityAgent !== args.runner.capabilityAgent) {
      reasons.push(
        `capability agent ${args.runner.capabilityAgent} does not match adapter ${args.runner.adapter}`,
      );
    }
    if (
      !adapterSupportsProvider(adapter.providerKinds, args.runner.provider.kind)
    ) {
      reasons.push(
        `provider ${args.runner.provider.kind} is not supported by adapter ${args.runner.adapter}`,
      );
    }
    if (
      !adapterSupportsPermissionPolicy(
        adapter.permissionPolicies,
        args.runner.permissionPolicy,
      )
    ) {
      reasons.push(
        `permission policy ${args.runner.permissionPolicy} is not supported by adapter ${args.runner.adapter}`,
      );
    }
  }

  const diagnosticAdapter = args.diagnostics?.adapters?.find(
    (item) => item.id === args.runner.adapter,
  );

  if (!args.diagnostics?.adapters) {
    reasons.push(`adapter diagnostics are unavailable: ${args.runner.adapter}`);
  } else if (!diagnosticAdapter) {
    reasons.push(`adapter diagnostics are missing: ${args.runner.adapter}`);
  } else if (!diagnosticAdapter.available) {
    reasons.push(`adapter binary is unavailable: ${args.runner.adapter}`);
  }
  // ACP compatibility smoke (gemini/opencode/mimo) is advisory, not a readiness
  // gate: a genuine handshake failure already flips `available` false on the
  // supervisor side. Pending/skipped smoke must not hold an otherwise-usable
  // adapter NotReady — the live model probe and launch surface real failures.

  if (args.runner.provider.kind === "anthropic_compatible") {
    if (!args.runner.sidecarId && !args.runner.provider.authToken) {
      reasons.push("anthropic-compatible provider requires auth token env ref");
    } else if (!args.runner.sidecarId) {
      pushMissingEnvReason(
        reasons,
        args.diagnostics ?? undefined,
        envRefName(args.runner.provider.authToken),
      );
    }
  }

  if (args.runner.provider.kind === "openai_compatible") {
    reasons.push(
      "Codex OpenAI-compatible provider materialization is not verified",
    );
    pushMissingEnvReason(
      reasons,
      args.diagnostics ?? undefined,
      envRefName(args.runner.provider.apiKey),
    );
  }

  if (args.runner.provider.kind === "google_gemini") {
    pushMissingEnvReason(
      reasons,
      args.diagnostics ?? undefined,
      envRefName(args.runner.provider.apiKey),
    );
  }

  if (args.runner.provider.kind === "google_vertex") {
    if (
      !args.runner.provider.apiKey &&
      (!args.runner.provider.projectId || !args.runner.provider.location)
    ) {
      reasons.push(
        "google_vertex provider requires either api key env ref or project id and location",
      );
    }
    pushMissingEnvReason(
      reasons,
      args.diagnostics ?? undefined,
      envRefName(args.runner.provider.apiKey),
    );
  }

  if (args.runner.provider.kind === "google_gateway") {
    if (!args.runner.provider.apiKey) {
      reasons.push("google_gateway provider requires api key env ref");
    } else {
      pushMissingEnvReason(
        reasons,
        args.diagnostics ?? undefined,
        envRefName(args.runner.provider.apiKey),
      );
    }
  }

  if (args.runner.sidecarId) {
    if (!args.sidecar) {
      reasons.push(`sidecar is missing: ${args.runner.sidecarId}`);
    } else {
      if (!args.sidecar.enabled) {
        reasons.push(`sidecar is disabled: ${args.runner.sidecarId}`);
      }
      if (args.sidecar.readinessStatus !== "Ready") {
        reasons.push(`sidecar is not ready: ${args.runner.sidecarId}`);
      }
    }

    const diagnosticSidecar = args.diagnostics?.sidecars?.find(
      (item) => item.id === args.runner.sidecarId,
    );

    if (diagnosticSidecar && diagnosticSidecar.state !== "ready") {
      reasons.push(
        `sidecar ${args.runner.sidecarId} is not ready: ${diagnosticSidecar.state}`,
      );
    }
  }

  return {
    status: reasons.length === 0 ? "Ready" : "NotReady",
    reasons,
  };
}

export function evaluateSidecarReadiness(args: {
  readonly sidecar: RouterSidecarReadinessInput;
  readonly diagnostics?: DiagnosticsInput | null;
  readonly diagnosticsUnavailableReason?: string | null;
}): SidecarReadinessResult {
  const reasons: string[] = [];

  if (!args.sidecar.enabled) {
    reasons.push("sidecar is disabled");
  }

  if (args.sidecar.lifecycle === "managed") {
    if (args.sidecar.commandPreset !== "ccr_start") {
      reasons.push("managed CCR sidecar requires ccr_start command preset");
    }
    if (!args.sidecar.configPath) {
      reasons.push("managed CCR sidecar requires config path");
    }
  }

  if (args.sidecar.lifecycle === "external") {
    if (!args.sidecar.baseUrl) {
      reasons.push("external CCR sidecar requires base URL");
    }
    if (!args.sidecar.healthcheckUrl) {
      reasons.push("external CCR sidecar requires healthcheck URL");
    }
  }

  if (!args.diagnostics) {
    reasons.push(
      args.diagnosticsUnavailableReason
        ? `supervisor diagnostics unavailable: ${args.diagnosticsUnavailableReason}`
        : "CCR sidecar health must be confirmed by supervisor diagnostics",
    );

    return {
      status: "NotReady",
      reasons,
    };
  }

  const diagnosticSidecar = args.diagnostics.sidecars?.find(
    (item) => item.id === args.sidecar.id,
  );

  if (!diagnosticSidecar) {
    reasons.push(`sidecar diagnostics missing: ${args.sidecar.id}`);
  } else if (diagnosticSidecar.state !== "ready") {
    reasons.push(
      `sidecar ${args.sidecar.id} is not ready: ${diagnosticSidecar.state}`,
    );
  }

  return {
    status: reasons.length === 0 ? "Ready" : "NotReady",
    reasons,
  };
}
