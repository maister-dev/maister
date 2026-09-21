import "server-only";

import type {
  McpReadinessContext,
  McpReadinessInput,
} from "@/lib/mcp/readiness";

import pino from "pino";

import { executionHosts } from "@/lib/execution-host";
import { referencedEnvNames } from "@/lib/mcp/value-grammar";

// ADR-177 (D18): the ONE place the two host READS behind MCP readiness happen.
// Shared by all three write-time cache sites — the platform routes, the project
// MCP service, and package attach/upgrade ingestion — so a host failure degrades
// the same way everywhere.
//
// These are READS, not side effects: they are issued BEFORE the transaction, any
// failure yields `Unknown` plus one WARN naming the host cause, and the write
// commits anyway. There is no idempotency marker because there is nothing to
// make idempotent.

const log = pino({
  name: "mcp-readiness-host",
  level: process.env.LOG_LEVEL ?? "info",
});

function causeOf(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    return String((err as { code: unknown }).code);
  }

  return err instanceof Error ? err.name : "unknown";
}

// `rows` is every row whose readiness this write recomputes — one chunked
// `checkEnvRefs` over the UNION of their referenced names, not one call per row.
export async function loadMcpReadinessContext(
  rows: readonly Pick<
    McpReadinessInput,
    "env" | "headers" | "bearerTokenEnv"
  >[],
  logContext: Record<string, unknown> = {},
): Promise<McpReadinessContext> {
  const names = [...new Set(rows.flatMap((row) => referencedEnvNames(row)))];
  const admin = executionHosts.local();
  const adapters = await admin.diagnostics().catch((err: unknown) => {
    log.warn(
      { ...logContext, cause: causeOf(err) },
      "mcp-readiness-host-unavailable",
    );

    return null;
  });

  log.debug(
    { ...logContext, referencedNames: names.length },
    "mcp-readiness-env-refs",
  );

  if (names.length === 0) return { presence: [], adapters };

  const presence = await admin.checkEnvRefs(names).catch((err: unknown) => {
    log.warn(
      { ...logContext, cause: causeOf(err) },
      "mcp-readiness-host-unavailable",
    );

    return null;
  });

  return { presence, adapters };
}
