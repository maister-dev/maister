import { getAdapterSupportById } from "@/lib/acp-runners/adapter-support";

// ADR-183: the librarian settings as the admin card sees them. Pure — the
// server computes it from rows the settings page already loads.

export type LibrarianAvailabilityState =
  | "ready"
  | "disabled"
  | "not_configured"
  | "runner_not_ready";

export type LibrarianRunnerIneligibility =
  | "capability_not_supported"
  | "builtin_denial_unverified"
  | "not_read_only_capable"
  | "skips_permissions"
  | "reserved_env";

type RunnerShape = {
  id: string;
  adapter?: string;
  capabilityAgent: string;
  model?: string;
  permissionPolicy: string;
  env?: Record<string, string> | null;
  enabled: boolean;
  readinessStatus?: string;
  ready?: boolean;
  readOnlyCapable?: boolean;
};

// Codex host reads need not emit an ACP permission request and it has no
// equivalent to Claude's built-in deny settings (ADR-184 D10).
const LIBRARIAN_CAPABILITIES: ReadonlySet<string> = new Set(["claude", "codex"]);
const RESERVED_RUNNER_ENV = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];

export function librarianRunnerIneligibility(
  runner: RunnerShape,
): LibrarianRunnerIneligibility | null {
  const readOnlyCapable =
    runner.readOnlyCapable ??
    getAdapterSupportById(runner.capabilityAgent)?.readOnlyCapable === true;

  if (!LIBRARIAN_CAPABILITIES.has(runner.capabilityAgent))
    return "capability_not_supported";
  if (runner.adapter && runner.adapter !== runner.capabilityAgent)
    return "capability_not_supported";
  if (runner.capabilityAgent === "codex")
    return "builtin_denial_unverified";
  if (!readOnlyCapable) return "not_read_only_capable";
  if (runner.permissionPolicy === "dangerously_skip_permissions")
    return "skips_permissions";
  if (RESERVED_RUNNER_ENV.some((name) => runner.env?.[name] !== undefined))
    return "reserved_env";

  return null;
}

function runnerReady(runner: RunnerShape): boolean {
  return runner.ready ?? runner.readinessStatus === "Ready";
}

export function librarianAvailabilityOf(
  enabled: boolean,
  runner: RunnerShape | null,
): LibrarianAvailabilityState {
  if (!enabled) return "disabled";
  if (!runner) return "not_configured";
  if (!runner.enabled || !runnerReady(runner)) return "runner_not_ready";
  if (librarianRunnerIneligibility(runner)) return "runner_not_ready";

  return "ready";
}

export type LibrarianRunnerOption = {
  id: string;
  label: string;
  ready: boolean;
  ineligible: LibrarianRunnerIneligibility | "disabled" | null;
};

export type LibrarianSettingsView = {
  enabled: boolean;
  runnerId: string | null;
  availability: LibrarianAvailabilityState;
  runners: LibrarianRunnerOption[];
};

export function librarianSettingsView(
  settings: {
    librarianEnabled?: boolean;
    librarianRunnerId?: string | null;
  } | null,
  runners: readonly RunnerShape[],
): LibrarianSettingsView {
  const enabled = settings?.librarianEnabled === true;
  const runnerId = settings?.librarianRunnerId ?? null;
  const selected = runners.find((runner) => runner.id === runnerId) ?? null;

  return {
    enabled,
    runnerId: selected ? runnerId : null,
    availability: librarianAvailabilityOf(enabled, selected),
    runners: runners.map((runner) => ({
      id: runner.id,
      label: runner.model ? `${runner.id} · ${runner.model}` : runner.id,
      ready: runnerReady(runner),
      ineligible: !runner.enabled
        ? "disabled"
        : librarianRunnerIneligibility(runner),
    })),
  };
}
