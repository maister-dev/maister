import type { SupervisorDiagnosticsStatus } from "@/lib/supervisor-client";

export type McpReadinessInput = {
  readonly transport: "stdio" | "sse" | "http";
  readonly command?: string | null;
  readonly url?: string | null;
  readonly envKeys?: readonly string[];
  readonly headerKeys?: readonly string[];
};

export type McpReadinessResult = {
  readonly status: "Unknown" | "Ready" | "NotReady";
  readonly reasons: string[];
};

function envRefName(ref: string): string {
  return ref.startsWith("env:") ? ref.slice("env:".length) : ref;
}

// Mirrors lib/acp-runners/readiness.ts `evaluateRunnerReadiness` for platform MCP
// servers: transport config × supervisor `/diagnostics` env references.
// Recomputed on every write (POST/PATCH), never on DELETE. Diagnostics
// unavailable → Unknown (env refs cannot be verified). Pure; no I/O, no secrets
// (only `env:NAME` names are read).
export function evaluateMcpReadiness(
  row: McpReadinessInput,
  diagnostics: SupervisorDiagnosticsStatus | null,
): McpReadinessResult {
  if (!diagnostics || diagnostics.kind !== "ready") {
    const reason =
      diagnostics?.kind === "unavailable"
        ? `supervisor diagnostics unavailable: ${diagnostics.reason}`
        : "supervisor diagnostics unavailable";

    return { status: "Unknown", reasons: [reason] };
  }

  const reasons: string[] = [];

  if (row.transport === "stdio") {
    if (!row.command) reasons.push("missing command");
  } else if (!row.url) {
    reasons.push("missing url");
  }

  const envRefs = diagnostics.diagnostics.envRefs;
  const referenced = [...(row.envKeys ?? []), ...(row.headerKeys ?? [])];

  for (const key of referenced) {
    const name = envRefName(key);
    const ref = envRefs.find((item) => item.name === name);

    if (!ref?.present) reasons.push(`env ref missing: ${name}`);
  }

  return {
    status: reasons.length === 0 ? "Ready" : "NotReady",
    reasons,
  };
}
