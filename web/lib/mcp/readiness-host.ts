import "server-only";

import type { HostAdminClient } from "@/lib/execution-host";
import type {
  McpReadinessContext,
  McpReadinessInput,
} from "@/lib/mcp/readiness";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { projects } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { executionHosts } from "@/lib/execution-host";
import { transportForSelectedHostId } from "@/lib/execution-host/default-transport";
import { resolveTaskLaunchPlacement } from "@/lib/execution-host/project-preference";
import { configuredSelectedExecutionEndpoint } from "@/lib/execution-host/selected-endpoint";
import { referencedEnvNames } from "@/lib/mcp/value-grammar";

// ADR-179 (D18): the ONE place the two host READS behind MCP readiness happen.
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

/** Probe settings against the host the project would select for a new Run. */
export async function mcpAdminForProject(
  projectId: string,
): Promise<Pick<HostAdminClient, "diagnostics" | "checkEnvRefs" | "probeMcp">> {
  if (!configuredSelectedExecutionEndpoint()) return executionHosts.local();
  const db = getDb();
  const [project] = await db
    .select({
      id: projects.id,
      defaultExecutionHostId: projects.defaultExecutionHostId,
      executionHostPreferenceRevision: projects.executionHostPreferenceRevision,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project)
    throw new MaisterError(
      "PRECONDITION",
      "Project not found for the MCP host probe",
      {
        details: { projectId },
      },
    );
  const placement = await resolveTaskLaunchPlacement(db, project, undefined);

  return placement
    ? transportForSelectedHostId(
        db,
        placement.selection.effectiveExecutionHostId,
      )
    : executionHosts.local();
}

// `rows` is every row whose readiness this write recomputes — one chunked
// `checkEnvRefs` over the UNION of their referenced names, not one call per row.
export async function loadMcpReadinessContext(
  rows: readonly Pick<
    McpReadinessInput,
    "env" | "headers" | "bearerTokenEnv"
  >[],
  logContext: Record<string, unknown> = {},
  projectId?: string,
): Promise<McpReadinessContext> {
  const names = [...new Set(rows.flatMap((row) => referencedEnvNames(row)))];
  const admin = await (
    projectId
      ? mcpAdminForProject(projectId)
      : Promise.resolve(executionHosts.local())
  ).catch((error: unknown) => {
    log.warn(
      { ...logContext, cause: causeOf(error) },
      "mcp-readiness-host-unavailable",
    );

    return null;
  });

  if (!admin) return { presence: null, adapters: null };
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
