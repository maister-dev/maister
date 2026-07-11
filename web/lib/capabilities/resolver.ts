import "server-only";

import type { CapabilityAgent } from "@/lib/config.schema";
import type {
  CapabilityCatalogRecord,
  CapabilityProfileEntry,
  ResolvedCapabilityProfile,
} from "@/lib/capabilities/types";
import type { ResolvedCapabilitySet } from "@/lib/db/schema";

import { createHash } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";
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

// ADR-129 (W-B): the resolver-facing shape of a project_mcp_bindings row. An
// enabled binding overrides SOURCE_PRECEDENCE for its ref; a disabled binding
// makes the ref unresolvable. Passed in from the catalog-assembly layer so the
// resolver stays pure.
export type McpBindingInput = {
  refId: string;
  targetKind: "platform" | "project" | "package";
  targetId: string;
  enabled: boolean;
};

const TARGET_KIND_TO_SOURCE: Record<McpBindingInput["targetKind"], string> = {
  platform: "platform",
  project: "project",
  package: "flow-package",
};

function bindingByRef(
  bindings: readonly McpBindingInput[] | undefined,
): Map<string, McpBindingInput> {
  const map = new Map<string, McpBindingInput>();

  for (const b of bindings ?? []) map.set(b.refId, b);

  return map;
}

// ADR-129 (W-B): the winning record for ONE mcp refId plus its provenance, or
// null when the ref is unresolvable — a disabled binding (explicit opt-out) or a
// binding whose target source has no record (misconfigured). Absent binding =
// SOURCE_PRECEDENCE (project > platform > flow-package). Shared by the snapshot
// builder, the selection materializer, and the agent-support gate so all three
// agree on the winner.
function pickMcpWinner<T extends { source: string }>(
  records: readonly T[],
  binding: McpBindingInput | undefined,
): {
  record: T;
  provenance: "binding" | "precedence";
  boundTarget?: { kind: McpBindingInput["targetKind"]; id: string };
} | null {
  if (records.length === 0) return null;

  if (binding) {
    if (!binding.enabled) return null;
    const wantSource = TARGET_KIND_TO_SOURCE[binding.targetKind];
    const match = records.find((r) => r.source === wantSource);

    if (!match) return null;

    return {
      record: match,
      provenance: "binding",
      boundTarget: { kind: binding.targetKind, id: binding.targetId },
    };
  }

  const winner = [...records].sort(
    (a, b) => sourceRank(a.source) - sourceRank(b.source),
  )[0];

  return { record: winner, provenance: "precedence" };
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
  // ADR-129 (W-B): enabled binding overrides precedence for its ref; disabled
  // binding excludes it from the executable set; absent = precedence.
  mcpBindings?: readonly McpBindingInput[];
}): ResolvedCapabilitySet {
  // Non-mcp: local-first winner per (kind, refId).
  const nonMcpWinner = new Map<string, (typeof args.records)[number]>();
  // mcp: candidate records grouped by refId, resolved with binding-awareness.
  const mcpByRef = new Map<string, (typeof args.records)[number][]>();

  for (const record of args.records) {
    if (record.kind === "mcp") {
      const list = mcpByRef.get(record.capabilityRefId) ?? [];

      list.push(record);
      mcpByRef.set(record.capabilityRefId, list);
      continue;
    }

    const key = `${record.kind}::${record.capabilityRefId}`;
    const existing = nonMcpWinner.get(key);

    if (!existing || sourceRank(record.source) < sourceRank(existing.source)) {
      nonMcpWinner.set(key, record);
    }
  }

  const bindings = bindingByRef(args.mcpBindings);
  const mcps: ResolvedCapabilitySet["mcps"] = [];

  for (const [refId, records] of mcpByRef) {
    const winner = pickMcpWinner(records, bindings.get(refId));

    if (!winner) continue; // disabled/misconfigured → unresolvable, excluded

    mcps.push({
      refId,
      sha: winner.record.revision,
      scope: winner.record.source,
      provenance: winner.provenance,
      ...(winner.boundTarget ? { boundTarget: winner.boundTarget } : {}),
    });
  }

  return {
    flowRevisionId: args.flowRevisionId,
    flowOrigin: args.flowOrigin,
    capabilities: [...nonMcpWinner.values()].map((r) => ({
      refId: r.capabilityRefId,
      kind: r.kind,
      sha: r.revision,
      scope: r.source,
    })),
    mcps,
  };
}

// M27/T-B5 (≡ C8b(1), ADR-069): constrain the runner's capability universe to
// the launch-frozen resolved set. Keeps only live records whose
// (kind, refId, scope) matches a frozen winner, so a record added/republished
// at any scope mid-run cannot enter (or override) what this run materializes —
// in-flight immutability. A null snapshot (legacy / pre-C8a run) falls back to
// the live catalog unchanged. Material is read from the (still-present) live
// row; set membership + winning scope are what the snapshot freezes.
export function pinCatalogToSnapshot<
  T extends { kind: string; capabilityRefId: string; source: string },
>(
  liveCatalog: readonly T[],
  snapshot: ResolvedCapabilitySet | null | undefined,
): T[] {
  if (!snapshot) return liveCatalog as T[];

  const frozen = new Set<string>();

  for (const c of snapshot.capabilities) {
    frozen.add(`${c.kind}::${c.refId}::${c.scope}`);
  }
  for (const m of snapshot.mcps) {
    frozen.add(`mcp::${m.refId}::${m.scope}`);
  }

  return liveCatalog.filter((r) =>
    frozen.has(`${r.kind}::${r.capabilityRefId}::${r.source}`),
  );
}

// M27/T-C8b (mcp-management.md §6.2): a REQUIRED mcp whose local-first WINNER
// record does not support the executor agent cannot materialize → the launch
// gate refuses with EXECUTOR_UNAVAILABLE. The winner is picked by the same
// precedence as resolution (project > platform > flow-package), so a shadowed
// lower-precedence record that WOULD support the agent does not rescue it. An
// unresolved required ref is owned by the unknown-ref gate (CONFIG); skipped
// here. Returns the first offending ref, or null when all required mcps resolve
// to an agent-supporting winner.
export function firstAgentUnsupportedRequiredMcp(
  requiredMcpRefs: readonly string[],
  mcpRecords: ReadonlyArray<{
    capabilityRefId: string;
    source: string;
    agents: CapabilityCatalogRecord["agents"];
  }>,
  agent: CapabilityAgent,
  // ADR-129 (W-B): a binding redirects which record is the effective winner; a
  // disabled/misconfigured binding makes the ref unresolvable (skipped here — the
  // CONFIG gate owns that), so this gate never flags a ref it cannot resolve.
  mcpBindings?: readonly McpBindingInput[],
): string | null {
  if (requiredMcpRefs.length === 0) return null;

  const bindings = bindingByRef(mcpBindings);
  const byRef = new Map<string, (typeof mcpRecords)[number][]>();

  for (const r of mcpRecords) {
    const list = byRef.get(r.capabilityRefId) ?? [];

    list.push(r);
    byRef.set(r.capabilityRefId, list);
  }

  for (const ref of new Set(requiredMcpRefs)) {
    const records = byRef.get(ref);

    if (!records) continue;

    const winner = pickMcpWinner(records, bindings.get(ref));

    if (!winner) continue;
    if (!supportsAgent(winner.record.agents, agent)) return ref;
  }

  return null;
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
  // ADR-129 (W-B): project MCP bindings threaded from the catalog-assembly layer.
  // Absent = grandfather (precedence). A disabled binding drops the ref from the
  // default set and refuses an explicit selection of it.
  mcpBindings?: readonly McpBindingInput[];
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
        // ADR-129 (D3): a package REQUIREMENT marker is not an executable server —
        // never enters the materializable set (the ledger reads it separately).
        sql`(${capabilityRecords.material} ->> 'requirement') IS DISTINCT FROM 'true'`,
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
  bindings?: Map<string, McpBindingInput>,
): string[] {
  if (explicitIds !== undefined) return [...new Set(explicitIds)].sort();
  if (kind !== "mcp") return [];

  return [
    ...new Set(
      catalog
        .filter((r) => r.kind === "mcp" && r.selectedByDefault)
        // ADR-129: a disabled binding is an explicit opt-out — drop the ref from
        // the default set even if the record is selectedByDefault.
        .filter((r) => bindings?.get(r.capabilityRefId)?.enabled !== false)
        .map((r) => r.capabilityRefId),
    ),
  ].sort();
}

function selectedRecords(
  catalog: readonly CapabilityCatalogRecord[],
  kind: CapabilityCatalogRecord["kind"],
  ids: readonly string[],
  bindings?: Map<string, McpBindingInput>,
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

    // ADR-129 (W-B): for mcp, an enabled binding picks the bound target's record;
    // a disabled/misconfigured binding on an explicitly-selected ref is a
    // conflict — refuse with a remediation-naming CONFIG (bind/reconnect).
    if (kind === "mcp" && bindings) {
      const winner = pickMcpWinner(records, bindings.get(id));

      if (!winner) {
        throw new MaisterError(
          "CONFIG",
          `MCP "${id}" is disconnected or misconfigured for this project — bind or configure it in Project → MCPs`,
        );
      }

      return winner.record;
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
  const mcpBindings = bindingByRef(args.mcpBindings);
  const selectedMcpIds = idsForKind(
    catalog,
    "mcp",
    args.selectedMcpIds,
    mcpBindings,
  );
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
    ...selectedRecords(catalog, "mcp", selectedMcpIds, mcpBindings),
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
