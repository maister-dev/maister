import type { SupervisorDiagnosticsStatus } from "@/lib/supervisor-client";

import {
  ADAPTER_SUPPORT,
  type AdapterId,
} from "@/lib/acp-runners/adapter-support";

export type AdapterReadinessState = "green" | "amber" | "hidden";

export type AdapterReadinessCause =
  | "ready"
  | "no_runner"
  | "all_disabled"
  | "not_ready"
  | "diagnostics_unavailable"
  | "binary_unavailable";

export type AdapterReadinessSummary = {
  readonly adapter: AdapterId;
  readonly state: AdapterReadinessState;
  readonly cause: AdapterReadinessCause;
  readonly detail: string | null;
};

export type RunnerReadinessRow = {
  readonly adapter: AdapterId;
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

    // Supervisor diagnostics unreachable: adapter availability is unknown.
    // Surface only adapters the operator actually configured (no noise), as
    // amber with the supervisor reason; hide the rest.
    if (!diagAdapters) {
      if (own.length === 0) {
        return adapterSummary(adapter.id, "hidden", "binary_unavailable", null);
      }

      return adapterSummary(
        adapter.id,
        "amber",
        "diagnostics_unavailable",
        diagnostics?.kind === "unavailable" ? diagnostics.reason : null,
      );
    }

    const diag = diagAdapters.find((item) => item.id === adapter.id);

    if (!diag?.available) {
      return adapterSummary(adapter.id, "hidden", "binary_unavailable", null);
    }
    if (hasReady) {
      return adapterSummary(adapter.id, "green", "ready", null);
    }
    if (own.length === 0) {
      return adapterSummary(adapter.id, "amber", "no_runner", null);
    }
    if (enabled.length === 0) {
      return adapterSummary(adapter.id, "amber", "all_disabled", null);
    }

    const firstReason =
      enabled
        .flatMap((runner) => runner.readinessReasons ?? [])
        .find((reason) => reason.length > 0) ?? null;

    return adapterSummary(adapter.id, "amber", "not_ready", firstReason);
  });
}

function adapterSummary(
  adapter: AdapterId,
  state: AdapterReadinessState,
  cause: AdapterReadinessCause,
  detail: string | null,
): AdapterReadinessSummary {
  return { adapter, state, cause, detail };
}
