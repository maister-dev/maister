import "server-only";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import {
  buildRequirementsLedger,
  type RequirementCandidate,
  type RequirementEntry,
} from "@/lib/mcp/requirements-ledger";

// ADR-129 (W-D, T6.1): the project MCP hub read model. Merges all THREE sources
// (platform / project / package) into one list with status columns and derives
// the requirements ledger (which refs a project needs and whether each is
// satisfied). Pure aggregation over already-loaded rows keeps it testable; the
// board tab and the header metacell both read this. Secrets never appear here —
// only NAMES and status.

const log = pino({ name: "mcp-hub", level: process.env.LOG_LEVEL ?? "info" });

type HubDb = { execute(query: SQL): Promise<{ rows?: unknown[] }> };

function db(injected?: HubDb): HubDb {
  return injected ?? (getDb() as unknown as HubDb);
}

function rowsOf<T>(result: { rows?: unknown[] }): T[] {
  return (result.rows ?? []) as T[];
}

export type HubSource = "platform" | "project" | "package";

export type HubServerEntry = {
  refId: string;
  source: HubSource;
  transport: string;
  enabled: boolean;
  trust?: string;
  readiness?: string;
  usedByCount?: number;
  boundByRefs: string[];
  lastProbeStatus?: string | null;
};

export type ProjectMcpHub = {
  servers: HubServerEntry[];
  requirements: RequirementEntry[];
  effectiveCount: number;
};

const SOURCE_TO_TARGET_KIND: Record<string, HubSource> = {
  platform: "platform",
  project: "project",
  "flow-package": "package",
};

type CapabilityRow = {
  capability_ref_id: string;
  source: string;
  material: {
    transport?: string;
    requirement?: boolean;
    envKeys?: string[];
    lastProbe?: { status?: string } | null;
  } | null;
  disabled_at: Date | string | null;
};

type PlatformRow = {
  id: string;
  transport: string;
  trust_status: string;
  readiness_status: string;
  last_probe_status: string | null;
  enabled: boolean;
};

type BindingRow = {
  ref_id: string;
  target_kind: HubSource;
  enabled: boolean;
  config_overlay: Record<string, unknown> | null;
};

// Compose the hub from already-loaded rows (pure; the DB read is the wrapper).
export function composeProjectMcpHub(args: {
  capabilityRows: readonly CapabilityRow[];
  platformRows: readonly PlatformRow[];
  bindings: readonly BindingRow[];
  usedByByServerId: ReadonlyMap<string, number>;
}): ProjectMcpHub {
  const platformById = new Map(args.platformRows.map((r) => [r.id, r]));
  const bindingByRef = new Map(args.bindings.map((b) => [b.ref_id, b]));
  const boundByRefsForTarget = new Map<string, string[]>();

  for (const b of args.bindings) {
    if (!b.enabled) continue;
    const key = b.ref_id; // a binding's ref IS the target key it selects by source
    const list = boundByRefsForTarget.get(key) ?? [];

    list.push(b.ref_id);
    boundByRefsForTarget.set(key, list);
  }

  // Servers: project + package come from capability_records; platform entries are
  // the projected capability rows enriched with live trust/readiness/used-by.
  const servers: HubServerEntry[] = [];

  for (const row of args.capabilityRows) {
    if (row.material?.requirement) continue; // a requirement is not a server

    const source = SOURCE_TO_TARGET_KIND[row.source] ?? "project";
    const platform =
      source === "platform"
        ? platformById.get(row.capability_ref_id)
        : undefined;

    servers.push({
      refId: row.capability_ref_id,
      source,
      transport: platform?.transport ?? row.material?.transport ?? "stdio",
      enabled: row.disabled_at === null,
      ...(platform
        ? {
            trust: platform.trust_status,
            readiness: platform.readiness_status,
            usedByCount: args.usedByByServerId.get(platform.id) ?? 0,
            lastProbeStatus: platform.last_probe_status,
          }
        : {
            lastProbeStatus: row.material?.lastProbe?.status ?? null,
          }),
      boundByRefs: boundByRefsForTarget.get(row.capability_ref_id) ?? [],
    });
  }

  // Requirements: package requirement markers + any bound/declared ref.
  const candidateSourcesByRef = new Map<string, Set<string>>();

  for (const row of args.capabilityRows) {
    if (row.material?.requirement) continue;
    if (row.disabled_at !== null) continue;
    const set = candidateSourcesByRef.get(row.capability_ref_id) ?? new Set();

    set.add(SOURCE_TO_TARGET_KIND[row.source] ?? row.source);
    candidateSourcesByRef.set(row.capability_ref_id, set);
  }

  const requirementRefs = new Set<string>();

  for (const row of args.capabilityRows) {
    if (row.material?.requirement) requirementRefs.add(row.capability_ref_id);
  }
  for (const b of args.bindings) requirementRefs.add(b.ref_id);

  const candidates: RequirementCandidate[] = [...requirementRefs].map(
    (refId) => {
      const binding = bindingByRef.get(refId);
      const boundPlatformTrust =
        binding?.target_kind === "platform"
          ? platformById.get(refId)?.trust_status
          : undefined;

      return {
        refId,
        required: true,
        declaredBy: [],
        candidateSources: [...(candidateSourcesByRef.get(refId) ?? [])],
        ...(binding
          ? {
              binding: {
                targetKind: binding.target_kind,
                enabled: binding.enabled,
                bindableTargetPresent:
                  (candidateSourcesByRef.get(refId)?.has(binding.target_kind) ??
                    false) ||
                  binding.target_kind === "platform",
                overlayValid: true,
              },
            }
          : {}),
        effectiveTrustWithheld:
          boundPlatformTrust !== undefined &&
          boundPlatformTrust !== "trusted" &&
          boundPlatformTrust !== "trusted_by_policy",
      };
    },
  );

  const requirements = buildRequirementsLedger(candidates).sort((a, b) =>
    a.refId.localeCompare(b.refId),
  );

  // Effective count: distinct executable refs (bound or auto, not disconnected).
  const effectiveCount = requirements.filter(
    (r) => r.classification === "bound" || r.classification === "auto",
  ).length;

  return { servers, requirements, effectiveCount };
}

export async function getProjectMcpHub(
  projectId: string,
  injected?: HubDb,
): Promise<ProjectMcpHub> {
  const database = db(injected);

  const capabilityRows = rowsOf<CapabilityRow>(
    await database.execute(sql`
      SELECT capability_ref_id, source, material, disabled_at
      FROM capability_records
      WHERE project_id = ${projectId} AND kind = 'mcp'
    `),
  );
  const platformRows = rowsOf<PlatformRow>(
    await database.execute(sql`
      SELECT id, transport, trust_status, readiness_status, last_probe_status, enabled
      FROM platform_mcp_servers
    `),
  );
  const bindings = rowsOf<BindingRow>(
    await database.execute(sql`
      SELECT ref_id, target_kind, enabled, config_overlay
      FROM project_mcp_bindings WHERE project_id = ${projectId}
    `),
  );

  // Used-by count per platform server id (distinct projects materializing it).
  const usageRows = rowsOf<{ id: string; n: string }>(
    await database.execute(sql`
      SELECT capability_ref_id AS id, count(DISTINCT project_id)::text AS n
      FROM capability_records
      WHERE kind = 'mcp' AND source = 'platform' AND disabled_at IS NULL
      GROUP BY capability_ref_id
    `),
  );
  const usedByByServerId = new Map(usageRows.map((r) => [r.id, Number(r.n)]));

  const hub = composeProjectMcpHub({
    capabilityRows,
    platformRows,
    bindings,
    usedByByServerId,
  });

  log.debug(
    {
      projectId,
      servers: hub.servers.length,
      requirements: hub.requirements.length,
      effectiveCount: hub.effectiveCount,
    },
    "[mcp.hub] assembled",
  );

  return hub;
}

// Just the project-effective MCP count (board-header metacell). Cheap wrapper.
export async function getProjectMcpEffectiveCount(
  projectId: string,
  injected?: HubDb,
): Promise<number> {
  return (await getProjectMcpHub(projectId, injected)).effectiveCount;
}
