import "server-only";

import type { RunnerCatalogEntry, RunnerSlotBinding } from "./resolve";

import { and, eq } from "drizzle-orm";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const { platformAcpRunners, platformRouterSidecars, flowRunnerRemaps } =
  schemaModule as unknown as Record<string, any>;

// A minimal read surface — every caller already holds a Drizzle client or a
// transaction; both satisfy this.
type Db = { select: (...args: any[]) => any };

function runnerProviderKind(provider: unknown): string {
  if (
    provider &&
    typeof provider === "object" &&
    "kind" in provider &&
    typeof (provider as { kind?: unknown }).kind === "string"
  ) {
    return (provider as { kind: string }).kind;
  }

  throw new MaisterError(
    "CONFIG",
    `platform ACP runner has invalid provider payload: ${JSON.stringify(provider)}`,
  );
}

function runnerCatalogEntry(
  row: Record<string, any>,
  sidecarById: ReadonlyMap<string, Record<string, any>>,
): RunnerCatalogEntry {
  const sidecar = row.sidecarId ? sidecarById.get(row.sidecarId) : undefined;

  return {
    id: row.id,
    adapter: row.adapter,
    capabilityAgent: row.capabilityAgent,
    model: row.model,
    env: row.env,
    provider: row.provider,
    providerKind: runnerProviderKind(row.provider),
    permissionPolicy: row.permissionPolicy,
    sidecar: sidecar
      ? {
          id: sidecar.id,
          kind: sidecar.kind,
          lifecycle: sidecar.lifecycle,
          configPath: sidecar.configPath,
          baseUrl: sidecar.baseUrl,
          healthcheckUrl: sidecar.healthcheckUrl,
          authTokenRef: sidecar.authTokenRef,
        }
      : null,
    sidecarId: row.sidecarId,
    enabled: row.enabled,
    ready: row.readinessStatus === "Ready",
  };
}

// M42 (ADR-114): the single source for the platform ACP runner catalog used by
// every launch-time resolution site (flow sessions, consensus slots, scratch,
// task-launch preview). Resolves each runner's sidecar snapshot inline.
export async function loadRunnerCatalog(db: Db): Promise<RunnerCatalogEntry[]> {
  const [runnerRows, sidecarRows] = await Promise.all([
    db.select().from(platformAcpRunners),
    db.select().from(platformRouterSidecars),
  ]);
  const sidecarById = new Map<string, Record<string, any>>(
    (sidecarRows as Record<string, any>[]).map((row) => [row.id, row]),
  );

  return (runnerRows as Record<string, any>[]).map((row) =>
    runnerCatalogEntry(row, sidecarById),
  );
}

// M42 (ADR-114): the per-slot bindings for a (project, flow revision). Keyed by
// `slot_key`; `Mapped` rows carry a concrete host runner, `Pending` rows are
// awaiting a connect-time binding.
export async function loadFlowRunnerBindings(
  db: Db,
  projectId: string,
  flowRevisionId: string,
): Promise<RunnerSlotBinding[]> {
  const rows = await db
    .select({
      slotKey: flowRunnerRemaps.slotKey,
      mappedRunnerId: flowRunnerRemaps.mappedRunnerId,
      status: flowRunnerRemaps.status,
    })
    .from(flowRunnerRemaps)
    .where(
      and(
        eq(flowRunnerRemaps.projectId, projectId),
        eq(flowRunnerRemaps.flowRevisionId, flowRevisionId),
      ),
    );

  return rows as RunnerSlotBinding[];
}
