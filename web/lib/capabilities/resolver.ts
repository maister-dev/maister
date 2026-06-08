import "server-only";

import type { CapabilityAgent } from "@/lib/config.schema";
import type {
  CapabilityCatalogRecord,
  CapabilityProfileEntry,
  ResolvedCapabilityProfile,
} from "@/lib/capabilities/types";
import type { ResolvedCapabilitySet } from "@/lib/db/schema";

import { createHash } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const { capabilityRecords } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "capability-resolver",
  level: process.env.LOG_LEVEL ?? "info",
});

// M27/T-C7 (§6.1): uniform local-first precedence for EVERY capability kind.
// Lower number wins. A project record shadows a platform record of the same
// (kind, refId), which shadows a flow-package record — no merge, no duplicate.
const SOURCE_PRECEDENCE: Record<string, number> = {
  project: 0,
  platform: 1,
  "flow-package": 2,
};

function sourceRank(source: string): number {
  return SOURCE_PRECEDENCE[source] ?? Number.MAX_SAFE_INTEGER;
}

// M27/T-C8 (§7.1.8): freeze the launch-time resolved capability set. Picks the
// local-first winner per (kind, refId) — same precedence as selectedRecords —
// then splits into capabilities (non-mcp) + mcps. Written onto
// runs.resolved_capability_set so an edit/publish mid-run cannot mutate the run.
export function buildResolvedCapabilitySet(args: {
  records: ReadonlyArray<{
    capabilityRefId: string;
    kind: string;
    source: string;
    revision: string | null;
  }>;
  flowRevisionId: string;
  flowOrigin: "authored" | "git";
}): ResolvedCapabilitySet {
  const winnerByKey = new Map<string, (typeof args.records)[number]>();

  for (const record of args.records) {
    const key = `${record.kind}::${record.capabilityRefId}`;
    const existing = winnerByKey.get(key);

    if (!existing || sourceRank(record.source) < sourceRank(existing.source)) {
      winnerByKey.set(key, record);
    }
  }

  const winners = [...winnerByKey.values()];

  return {
    flowRevisionId: args.flowRevisionId,
    flowOrigin: args.flowOrigin,
    capabilities: winners
      .filter((r) => r.kind !== "mcp")
      .map((r) => ({
        refId: r.capabilityRefId,
        kind: r.kind,
        sha: r.revision,
      })),
    mcps: winners
      .filter((r) => r.kind === "mcp")
      .map((r) => ({
        refId: r.capabilityRefId,
        sha: r.revision,
        scope: r.source,
      })),
  };
}

export type ResolveCapabilityProfileArgs = {
  projectId: string;
  executorAgent: CapabilityAgent;
  selectedMcpIds?: string[];
  selectedSkillIds?: string[];
  selectedRuleIds?: string[];
  selectedAgentDefinitionIds?: string[];
  selectedRestrictionIds?: string[];
  planMode: "off" | "plan-first";
  workMode?: "auto" | "plan_first" | "manual_approval";
  reasoningEffort?: "low" | "high" | "extra" | "ultra";
  catalog: CapabilityCatalogRecord[];
};

export async function loadSelectableCapabilities(
  projectId: string,
  db: any = getDb(),
): Promise<CapabilityCatalogRecord[]> {
  const rows = await db
    .select()
    .from(capabilityRecords)
    .where(
      and(
        eq(capabilityRecords.projectId, projectId),
        eq(capabilityRecords.selectable, true),
        isNull(capabilityRecords.disabledAt),
      ),
    );

  return rows.map((row: any) => ({
    id: row.id,
    projectId: row.projectId,
    capabilityRefId: row.capabilityRefId,
    kind: row.kind,
    label: row.label,
    source: row.source,
    version: row.version,
    revision: row.revision,
    agents: row.agents,
    enforceability: row.enforceability,
    selectedByDefault: row.selectedByDefault,
    selectable: row.selectable,
    material: row.material,
  }));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));

    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function digestProfile(
  profile: Omit<ResolvedCapabilityProfile, "profileDigest">,
) {
  return createHash("sha256").update(stableStringify(profile)).digest("hex");
}

function supportsAgent(
  agents: CapabilityCatalogRecord["agents"],
  executorAgent: CapabilityAgent,
): boolean {
  if (Array.isArray(agents)) return agents.includes(executorAgent);

  return agents[executorAgent] !== undefined;
}

function asEntry(
  record: CapabilityCatalogRecord,
  executorAgent: CapabilityAgent,
): CapabilityProfileEntry {
  return {
    id: record.id,
    capabilityRefId: record.capabilityRefId,
    kind: record.kind,
    source: record.source,
    label: record.label,
    enforceability: record.enforceability,
    revision: record.revision,
    agentName: Array.isArray(record.agents)
      ? null
      : (record.agents[executorAgent] ?? null),
    material: record.material,
  };
}

function idsForKind(
  catalog: readonly CapabilityCatalogRecord[],
  kind: CapabilityCatalogRecord["kind"],
  explicitIds: string[] | undefined,
): string[] {
  if (explicitIds !== undefined) return [...new Set(explicitIds)].sort();
  if (kind !== "mcp") return [];

  return [
    ...new Set(
      catalog
        .filter((r) => r.kind === "mcp" && r.selectedByDefault)
        .map((r) => r.capabilityRefId),
    ),
  ].sort();
}

function selectedRecords(
  catalog: readonly CapabilityCatalogRecord[],
  kind: CapabilityCatalogRecord["kind"],
  ids: readonly string[],
): CapabilityCatalogRecord[] {
  const byRef = new Map<string, CapabilityCatalogRecord[]>();

  for (const record of catalog.filter((r) => r.kind === kind)) {
    const records = byRef.get(record.capabilityRefId) ?? [];

    records.push(record);
    byRef.set(record.capabilityRefId, records);
  }

  return ids.map((id) => {
    const records = byRef.get(id);

    if (!records || records.length === 0) {
      throw new MaisterError(
        "CONFIG",
        `Unknown or unavailable ${kind} capability id "${id}"`,
      );
    }

    // Local-first winner (§6.1): exactly ONE record per (kind, refId) by
    // source precedence project > platform > flow-package. Same id at a lower
    // precedence is shadowed (NOT merged, NOT duplicated). Tie-break on the
    // unique row id for determinism.
    return [...records].sort((a, b) => {
      const bySource = sourceRank(a.source) - sourceRank(b.source);

      return bySource !== 0 ? bySource : a.id.localeCompare(b.id);
    })[0];
  });
}

export function resolveCapabilityProfile(
  args: ResolveCapabilityProfileArgs,
): ResolvedCapabilityProfile {
  const catalog = args.catalog.filter(
    (r) => r.projectId === args.projectId && r.selectable,
  );
  const selectedMcpIds = idsForKind(catalog, "mcp", args.selectedMcpIds);
  const selectedSkillIds = idsForKind(catalog, "skill", args.selectedSkillIds);
  const selectedRuleIds = idsForKind(catalog, "rule", args.selectedRuleIds);
  const selectedAgentDefinitionIds = idsForKind(
    catalog,
    "agent_definition",
    args.selectedAgentDefinitionIds,
  );
  const selectedRestrictionIds = idsForKind(
    catalog,
    "restriction",
    args.selectedRestrictionIds,
  );
  const selected = [
    ...selectedRecords(catalog, "mcp", selectedMcpIds),
    ...selectedRecords(catalog, "skill", selectedSkillIds),
    ...selectedRecords(catalog, "rule", selectedRuleIds),
    ...selectedRecords(catalog, "agent_definition", selectedAgentDefinitionIds),
    ...selectedRecords(catalog, "restriction", selectedRestrictionIds),
  ];

  log.debug(
    {
      projectId: args.projectId,
      executorAgent: args.executorAgent,
      winners: selected.map(
        (r) => `${r.kind}/${r.capabilityRefId}@${r.source}`,
      ),
    },
    "[capabilities.resolver] local-first winners selected",
  );

  const enforced: CapabilityProfileEntry[] = [];
  const instructed: CapabilityProfileEntry[] = [];
  const supported: CapabilityProfileEntry[] = [];
  const unsupported: CapabilityProfileEntry[] = [];
  const refused: CapabilityProfileEntry[] = [];
  const downgraded: ResolvedCapabilityProfile["downgraded"] = [];

  for (const record of selected) {
    const entry = asEntry(record, args.executorAgent);
    const supportedByAgent = supportsAgent(record.agents, args.executorAgent);

    if (supportedByAgent) {
      supported.push(entry);
      if (record.enforceability === "enforced") enforced.push(entry);
      else instructed.push(entry);
      continue;
    }

    unsupported.push(entry);
    if (record.enforceability === "enforced") {
      refused.push(entry);
      continue;
    }

    downgraded.push({
      ...entry,
      reason: `executor ${args.executorAgent} does not support capability`,
    });
    instructed.push(entry);
  }

  if (refused.length > 0) {
    throw new MaisterError(
      "CONFIG",
      `Capability selection refused for executor ${args.executorAgent}: ${refused
        .map((r) => `${r.kind}/${r.capabilityRefId}`)
        .join(", ")}`,
    );
  }

  const withoutDigest = {
    projectId: args.projectId,
    executorAgent: args.executorAgent,
    planMode: args.planMode,
    workMode: args.workMode ?? "auto",
    reasoningEffort: args.reasoningEffort ?? "high",
    selectedMcpIds,
    selectedSkillIds,
    selectedRuleIds,
    selectedAgentDefinitionIds,
    selectedRestrictionIds,
    enforced,
    instructed,
    supported,
    unsupported,
    refused,
    downgraded,
  };

  return {
    ...withoutDigest,
    profileDigest: digestProfile(withoutDigest),
  };
}
