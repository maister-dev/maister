import "server-only";

import type { CapabilityAgent } from "@/lib/config.schema";
import type {
  CapabilityCatalogRecord,
  CapabilityProfileEntry,
  ResolvedCapabilityProfile,
} from "@/lib/capabilities/types";

import { createHash } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const { capabilityRecords } = schemaModule as unknown as Record<string, any>;

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

  return ids.flatMap((id) => {
    const records = byRef.get(id);

    if (!records) {
      throw new MaisterError(
        "CONFIG",
        `Unknown or unavailable ${kind} capability id "${id}"`,
      );
    }

    return [...records].sort((a, b) => {
      const sourceOrder = a.source.localeCompare(b.source);

      return sourceOrder === 0 ? a.id.localeCompare(b.id) : sourceOrder;
    });
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
