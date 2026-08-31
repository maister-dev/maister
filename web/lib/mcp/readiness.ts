export type McpReadinessInput = {
  readonly transport: "stdio" | "sse" | "http";
  readonly command?: string | null;
  readonly url?: string | null;
  readonly envKeys?: readonly string[];
  readonly headerKeys?: readonly string[];
  readonly supportedAgents?: readonly string[] | null;
};

// Structural view of `SupervisorDiagnosticsStatus` narrowed to what MCP
// readiness reads (mirrors the local `DiagnosticsInput` pattern in
// lib/acp-runners/readiness.ts). The full client type stays assignable.
export type McpDiagnosticsInput =
  | {
      readonly kind: "ready";
      readonly diagnostics: {
        readonly envRefs: readonly { name: string; present: boolean }[];
        readonly adapters?: readonly { id: string; available: boolean }[];
      };
    }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
      readonly message: string;
    }
  | null;

export type McpReadinessResult = {
  readonly status: "Unknown" | "Ready" | "NotReady";
  readonly reasons: string[];
};

function envRefName(ref: string): string {
  return ref.startsWith("env:") ? ref.slice("env:".length) : ref;
}

// Mirrors lib/acp-runners/readiness.ts `evaluateRunnerReadiness` for platform MCP
// servers: transport config × supervisor `/diagnostics` env references ×
// supported-agent adapter availability. Recomputed on every write (POST/PATCH),
// never on DELETE. Diagnostics unavailable → Unknown (env refs cannot be
// verified). Pure; no I/O, no secrets (only `env:NAME` names are read).
export function evaluateMcpReadiness(
  row: McpReadinessInput,
  diagnostics: McpDiagnosticsInput,
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

  // A server no available adapter can host is not usable whatever its own
  // config says: gate on adapter availability for the declared supported
  // agents (undeclared = supports every adapter, per lib/mcp/projection.ts).
  // Older supervisors that report no adapters skip the check.
  const adapters = diagnostics.diagnostics.adapters;

  if (adapters && adapters.length > 0) {
    const declared =
      row.supportedAgents && row.supportedAgents.length > 0
        ? row.supportedAgents
        : null;
    const supported = declared ?? adapters.map((adapter) => adapter.id);
    const anyAvailable = adapters.some(
      (adapter) => adapter.available && supported.includes(adapter.id),
    );

    if (!anyAvailable) {
      reasons.push(
        declared
          ? `no supported adapter available: ${declared.join(", ")}`
          : "no adapter available",
      );
    }
  }

  return {
    status: reasons.length === 0 ? "Ready" : "NotReady",
    reasons,
  };
}
