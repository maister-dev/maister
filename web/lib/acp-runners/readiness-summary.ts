import type { SupervisorDiagnosticsStatus } from "@/lib/supervisor-client";
import type { PlatformRunnerProvider } from "@/lib/db/schema";

import {
  ADAPTER_SUPPORT,
  type AdapterId,
  type ProviderKind,
} from "@/lib/acp-runners/adapter-support";

export type AdapterReadinessState = "green" | "amber" | "hidden";

export type AdapterReadinessCause =
  | "ready"
  | "no_runner"
  | "all_disabled"
  | "not_ready"
  | "diagnostics_unavailable"
  | "binary_unavailable";

// Safe, client-shippable projection of a configured runner for the rail
// popover. NEVER carries `provider` secret refs (authToken/apiKey/baseUrl/…) —
// only `providerKind`. See readiness-summary mapping (`toRailRunnerDTO`).
export type RailRunnerDTO = {
  readonly id: string;
  readonly capabilityAgent: AdapterId;
  readonly model: string;
  readonly providerKind: ProviderKind;
  readonly enabled: boolean;
  readonly readinessStatus: "Unknown" | "Ready" | "NotReady";
  readonly firstReason: string | null;
};

export type AdapterReadinessSummary = {
  readonly adapter: AdapterId;
  readonly state: AdapterReadinessState;
  readonly cause: AdapterReadinessCause;
  readonly detail: string | null;
  readonly runners: readonly RailRunnerDTO[];
};

export type RunnerReadinessRow = {
  readonly id: string;
  readonly adapter: AdapterId;
  readonly capabilityAgent: AdapterId;
  readonly model: string;
  readonly provider: PlatformRunnerProvider;
  readonly enabled: boolean;
  readonly readinessStatus: "Unknown" | "Ready" | "NotReady";
  readonly readinessReasons: readonly string[] | null;
};

// Collapses the live supervisor `/diagnostics` adapter availability with the
// stored per-runner readiness into a single green / amber / hidden verdict per
// adapter, used by the rail "Runners readiness" block. Stored `readinessStatus`
// is recomputed on every runner write (ADR-065), so it is fresh enough; live
// `available` gates visibility so an adapter whose binary disappeared is hidden
// even if a runner row still reads `Ready`.
export function summarizeAdapterReadiness(args: {
  readonly runners: readonly RunnerReadinessRow[];
  readonly diagnostics: SupervisorDiagnosticsStatus | null;
}): AdapterReadinessSummary[] {
  const { runners, diagnostics } = args;
  const diagAdapters =
    diagnostics?.kind === "ready" ? diagnostics.diagnostics.adapters : null;

  return ADAPTER_SUPPORT.map((adapter): AdapterReadinessSummary => {
    const own = runners.filter((runner) => runner.adapter === adapter.id);
    const enabled = own.filter((runner) => runner.enabled);
    const hasReady = enabled.some(
      (runner) => runner.readinessStatus === "Ready",
    );
    const runnerDtos = own.map(toRailRunnerDTO);

    const verdict = ((): RunnerVerdict => {
      // Supervisor diagnostics unreachable: adapter availability is unknown.
      // Surface only adapters the operator actually configured (no noise), as
      // amber with the supervisor reason; hide the rest.
      if (!diagAdapters) {
        if (own.length === 0) {
          return { state: "hidden", cause: "binary_unavailable", detail: null };
        }

        return {
          state: "amber",
          cause: "diagnostics_unavailable",
          detail:
            diagnostics?.kind === "unavailable" ? diagnostics.reason : null,
        };
      }

      const diag = diagAdapters.find((item) => item.id === adapter.id);

      if (!diag?.available) {
        return { state: "hidden", cause: "binary_unavailable", detail: null };
      }
      if (hasReady) {
        return { state: "green", cause: "ready", detail: null };
      }
      if (own.length === 0) {
        return { state: "amber", cause: "no_runner", detail: null };
      }
      if (enabled.length === 0) {
        return { state: "amber", cause: "all_disabled", detail: null };
      }

      const firstReason =
        enabled
          .flatMap((runner) => runner.readinessReasons ?? [])
          .find((reason) => reason.length > 0) ?? null;

      return { state: "amber", cause: "not_ready", detail: firstReason };
    })();

    return { adapter: adapter.id, ...verdict, runners: runnerDtos };
  });
}

type RunnerVerdict = {
  readonly state: AdapterReadinessState;
  readonly cause: AdapterReadinessCause;
  readonly detail: string | null;
};

// Maps a configured runner row to its safe rail DTO. Reads ONLY `provider.kind`
// — the secret-bearing provider fields (authToken/apiKey/baseUrl/projectId)
// never cross to the client.
function toRailRunnerDTO(runner: RunnerReadinessRow): RailRunnerDTO {
  const firstReason =
    (runner.readinessReasons ?? []).find((reason) => reason.length > 0) ?? null;

  return {
    id: runner.id,
    capabilityAgent: runner.capabilityAgent,
    model: runner.model,
    providerKind: runner.provider.kind,
    enabled: runner.enabled,
    readinessStatus: runner.readinessStatus,
    firstReason,
  };
}
