import type { SupervisorDiagnostics } from "../../lib/supervisor-client";

/** The two simulated adapters expose readiness, without claiming smoke qualification. */
export function e2eSupervisorDiagnostics(
  version: string,
): SupervisorDiagnostics {
  return {
    status: "ready",
    version,
    checkedAt: new Date().toISOString(),
    adapters: (["claude", "codex"] as const).map(
      (id): SupervisorDiagnostics["adapters"][number] => ({
        id,
        binary: id === "claude" ? "claude-agent-acp" : "codex-acp",
        source: "override",
        path: null,
        available: true,
        version: "e2e",
        error: null,
        smoke: {
          status: "not_required",
          reason: null,
          checkedAt: null,
          protocolVersion: null,
          readOnlySession: {
            status: "not_required",
            reason: null,
            checkedAt: null,
            protocolVersion: null,
            probeVersion: null,
            staleReason: null,
          },
          capabilityEnforcement: {
            status: "not_required",
            reason: null,
            checkedAt: null,
            protocolVersion: null,
          },
        },
      }),
    ),
    envRefs: [{ name: "ZAI_API_KEY", present: false }],
  };
}
