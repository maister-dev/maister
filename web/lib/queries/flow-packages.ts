import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, eq, inArray, notInArray } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import {
  isEngineCompatible,
  isSchemaVersionSupported,
} from "@/lib/flows/engine-version";

const { flowRevisions, flows, runs } = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

const NON_TERMINAL_RUN_STATUSES = [
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "Review",
  "Crashed",
] as const;

export interface FlowRevisionView {
  id: string;
  versionLabel: string;
  resolvedRevision: string;
  packageStatus: string;
  setupStatus: string;
  installedAt: Date;
}

export interface FlowContractView {
  capabilities: string[];
  gates: string[];
  artifacts: string[];
  externalOps: string[];
}

export interface FlowPackageView {
  flowRowId: string;
  ref: string;
  enablementState: string;
  trustStatus: string;
  enabledRevision: FlowRevisionView | null;
  enabledContract: FlowContractView | null;
  hasSetupScript: boolean;
  compatWarning: string | null;
  availableUpdate: FlowRevisionView | null;
  installedRevisions: FlowRevisionView[];
  activeRunsOnOldRevision: number;
  projectsUsing: number;
}

function toRevisionView(r: {
  id: string;
  versionLabel: string;
  resolvedRevision: string;
  packageStatus: string;
  setupStatus: string;
  installedAt: Date;
}): FlowRevisionView {
  return {
    id: r.id,
    versionLabel: r.versionLabel,
    resolvedRevision: r.resolvedRevision,
    packageStatus: r.packageStatus,
    setupStatus: r.setupStatus,
    installedAt: r.installedAt,
  };
}

function contractOf(contract: unknown): FlowContractView {
  const c = (contract ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  return {
    capabilities: arr(c.capabilities),
    gates: arr(c.gates),
    artifacts: arr(c.artifacts),
    externalOps: arr(c.external_ops),
  };
}

// Build the Flow Packages settings view for a project (M10, ADR-021): enabled
// revision, trust/enablement state, installed revisions (rollback candidates),
// available update, compatibility warnings, declared contract, count of active
// runs pinned to an older revision, and how many projects use the package.
export async function getFlowPackages(
  projectId: string,
): Promise<FlowPackageView[]> {
  const client = db();

  const flowRows = await client
    .select({
      id: flows.id,
      ref: flows.flowRefId,
      source: flows.source,
      enabledRevisionId: flows.enabledRevisionId,
      enablementState: flows.enablementState,
      trustStatus: flows.trustStatus,
    })
    .from(flows)
    .where(eq(flows.projectId, projectId));

  if (flowRows.length === 0) return [];

  const refs = [...new Set(flowRows.map((f) => f.ref))];

  // Installed (non-Removed) revisions for these refs, globally.
  const revisionRows = await client
    .select({
      id: flowRevisions.id,
      ref: flowRevisions.flowRefId,
      source: flowRevisions.source,
      versionLabel: flowRevisions.versionLabel,
      resolvedRevision: flowRevisions.resolvedRevision,
      packageStatus: flowRevisions.packageStatus,
      setupStatus: flowRevisions.setupStatus,
      schemaVersion: flowRevisions.schemaVersion,
      engineMin: flowRevisions.engineMin,
      engineMax: flowRevisions.engineMax,
      contract: flowRevisions.contract,
      manifest: flowRevisions.manifest,
      installedAt: flowRevisions.installedAt,
    })
    .from(flowRevisions)
    .where(
      and(
        inArray(flowRevisions.flowRefId, refs),
        notInArray(flowRevisions.packageStatus, ["Removed"]),
      ),
    );

  const revisionsByRef = new Map<string, typeof revisionRows>();

  for (const r of revisionRows) {
    const list = revisionsByRef.get(r.ref) ?? [];

    list.push(r);
    revisionsByRef.set(r.ref, list);
  }

  // Active runs pinned to an older revision than the project-enabled one.
  const flowRowIds = flowRows.map((f) => f.id);
  const activeRunRows = await client
    .select({ flowId: runs.flowId, flowRevisionId: runs.flowRevisionId })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        inArray(runs.flowId, flowRowIds),
        inArray(runs.status, [...NON_TERMINAL_RUN_STATUSES]),
      ),
    );

  // How many distinct projects use each ref.
  const usageRows = await client
    .select({ ref: flows.flowRefId, projectId: flows.projectId })
    .from(flows)
    .where(inArray(flows.flowRefId, refs));
  const projectsUsingByRef = new Map<string, Set<string>>();

  for (const u of usageRows) {
    const set = projectsUsingByRef.get(u.ref) ?? new Set<string>();

    set.add(u.projectId);
    projectsUsingByRef.set(u.ref, set);
  }

  return flowRows.map((flow) => {
    // Source-scope: only surface revisions installed from THIS project's
    // declared source for the flow id. Revisions are globally shared by
    // (flowRefId, resolvedRevision), so without this filter a project could see
    // and roll back to a revision installed by another project from a different
    // (possibly untrusted) source under the same flow id (ADR-021).
    const revisions = (revisionsByRef.get(flow.ref) ?? [])
      .filter((r) => r.source === flow.source)
      .slice()
      .sort((a, b) => b.installedAt.getTime() - a.installedAt.getTime());
    const enabled =
      revisions.find((r) => r.id === flow.enabledRevisionId) ?? null;

    const installedOnly = revisions.filter(
      (r) => r.packageStatus === "Installed",
    );

    let availableUpdate: FlowRevisionView | null = null;

    if (enabled) {
      const newer = installedOnly.find(
        (r) =>
          r.id !== enabled.id &&
          r.installedAt.getTime() > enabled.installedAt.getTime(),
      );

      availableUpdate = newer ? toRevisionView(newer) : null;
    }

    let compatWarning: string | null = null;

    if (enabled) {
      if (!isSchemaVersionSupported(enabled.schemaVersion)) {
        compatWarning = `unsupported manifest schemaVersion ${enabled.schemaVersion}`;
      } else {
        const compat = isEngineCompatible(
          enabled.engineMin ?? undefined,
          enabled.engineMax ?? undefined,
        );

        if (!compat.compatible) compatWarning = compat.reason;
      }
    }

    const activeRunsOnOldRevision = activeRunRows.filter(
      (r) =>
        r.flowId === flow.id &&
        r.flowRevisionId !== null &&
        r.flowRevisionId !== flow.enabledRevisionId,
    ).length;

    const enabledManifest = (enabled?.manifest ?? null) as {
      setup?: string;
    } | null;

    return {
      flowRowId: flow.id,
      ref: flow.ref,
      enablementState: flow.enablementState,
      trustStatus: flow.trustStatus,
      enabledRevision: enabled ? toRevisionView(enabled) : null,
      enabledContract: enabled ? contractOf(enabled.contract) : null,
      hasSetupScript: enabledManifest?.setup !== undefined,
      compatWarning,
      availableUpdate,
      installedRevisions: installedOnly.map(toRevisionView),
      activeRunsOnOldRevision,
      projectsUsing: projectsUsingByRef.get(flow.ref)?.size ?? 1,
    };
  });
}
