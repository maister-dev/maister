import { referencedEnvNames } from "@/lib/mcp/value-grammar";

export type McpReadinessInput = {
  readonly transport: "stdio" | "sse" | "http";
  readonly command?: string | null;
  readonly url?: string | null;
  readonly env?: Readonly<Record<string, string>> | null;
  readonly headers?: Readonly<Record<string, string>> | null;
  readonly bearerTokenEnv?: string | null;
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

// ADR-177: presence comes from the HOST (`POST /diagnostics/env-refs`), not
// from the fixed `GET /diagnostics.envRefs` catalog — that list enumerates
// provider credentials, so every MCP referencing `env:GITHUB_TOKEN` was
// falsely NotReady until an operator edited an unrelated supervisor variable.
// `null` = the host read failed, which yields Unknown like a dead host.
export type McpEnvPresenceInput =
  | readonly { readonly name: string; readonly present: boolean }[]
  | null;

export type McpReadinessContext = {
  readonly presence: McpEnvPresenceInput;
  readonly adapters: McpDiagnosticsInput;
};

// Mirrors lib/acp-runners/readiness.ts `evaluateRunnerReadiness` for MCP rows:
// transport config × HOST env-ref presence × supported-agent adapter
// availability. Recomputed on every write (POST/PATCH), never on DELETE, and
// cached the same way for project rows (create/update) and package rows
// (attach/upgrade). Either host read failing → Unknown. Pure; no I/O, and the
// only thing it reads out of a value is the NAME behind an `env:` reference — a
// LITERAL references nothing and so never produces a reason.
export function evaluateMcpReadiness(
  row: McpReadinessInput,
  context: McpReadinessContext,
): McpReadinessResult {
  const diagnostics = context.adapters;

  if (!diagnostics || diagnostics.kind !== "ready") {
    const reason =
      diagnostics?.kind === "unavailable"
        ? `supervisor diagnostics unavailable: ${diagnostics.reason}`
        : "supervisor diagnostics unavailable";

    return { status: "Unknown", reasons: [reason] };
  }

  if (!context.presence) {
    return {
      status: "Unknown",
      reasons: ["host env-ref presence unavailable"],
    };
  }

  const reasons: string[] = [];

  if (row.transport === "stdio") {
    if (!row.command) reasons.push("missing command");
  } else if (!row.url) {
    reasons.push("missing url");
  }

  const presentByName = new Map(
    context.presence.map((ref) => [ref.name, ref.present]),
  );

  for (const name of referencedEnvNames(row)) {
    if (presentByName.get(name) !== true) {
      reasons.push(`env ref missing: ${name}`);
    }
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
