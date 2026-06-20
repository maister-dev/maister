import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, asc, eq, inArray, notInArray } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import {
  isEngineCompatible,
  isSchemaVersionSupported,
} from "@/lib/flows/engine-version";

const { flowRevisions, flows, projects, runs } = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

const NON_TERMINAL_RUN_STATUSES = [
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "WaitingOnChildren",
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

// A single installed revision, resolved server-side. `installedPath` and the
// raw `manifest` are SERVER-ONLY (§3.1): the page reads disk + compiles the
// graph from them, but never hands either to a client component. The client
// gets `FlowRevisionDetailDTO` instead.
export interface FlowRevisionDetail {
  id: string;
  versionLabel: string;
  resolvedRevision: string;
  manifestDigest: string;
  manifest: FlowYamlV1;
  execTrust: string;
  setupStatus: string;
  packageStatus: string;
  installedPath: string;
}

export interface FlowRevisionDetailDTO {
  id: string;
  versionLabel: string;
  resolvedRevision: string;
  manifestDigest: string;
  execTrust: string;
  packageStatus: string;
}

// Client-safe header + revision-list projection. NO `installedPath`, NO
// `manifest` blob — the invariant in §3.1.
export interface FlowPackageDetailDTO {
  ref: string;
  version: string;
  versionBinding: string;
  trustStatus: string;
  enablementState: string;
  enabledRevisionId: string | null;
  revisions: FlowRevisionDetailDTO[];
}

export interface FlowPackageDetail {
  project: { id: string; slug: string; name: string };
  flow: {
    id: string;
    flowRefId: string;
    source: string;
    enabledRevisionId: string | null;
  };
  revisions: FlowRevisionDetail[];
  dto: FlowPackageDetailDTO;
}

function toRevisionDetailDTO(r: FlowRevisionDetail): FlowRevisionDetailDTO {
  return {
    id: r.id,
    versionLabel: r.versionLabel,
    resolvedRevision: r.resolvedRevision,
    manifestDigest: r.manifestDigest,
    execTrust: r.execTrust,
    packageStatus: r.packageStatus,
  };
}

// Resolve a single installed package for the viewer page (§5.4): the project,
// the (projectId, flowRefId) flows row, and its source-scoped installed
// revisions (the same source-scope guard as getFlowPackages — a project must
// not see/select a revision installed by another project from a different
// source under the same flow id, ADR-021). Returns null when the project or the
// flow does not exist → the page calls notFound().
export async function getFlowPackageDetail(
  slug: string,
  flowRefId: string,
): Promise<FlowPackageDetail | null> {
  const client = db();

  const projectRows = await client
    .select({ id: projects.id, slug: projects.slug, name: projects.name })
    .from(projects)
    .where(eq(projects.slug, slug));
  const project = projectRows[0];

  if (!project) return null;

  const flowRows = await client
    .select({
      id: flows.id,
      flowRefId: flows.flowRefId,
      source: flows.source,
      version: flows.version,
      versionBinding: flows.versionBinding,
      enabledRevisionId: flows.enabledRevisionId,
      enablementState: flows.enablementState,
      trustStatus: flows.trustStatus,
    })
    .from(flows)
    .where(
      and(eq(flows.projectId, project.id), eq(flows.flowRefId, flowRefId)),
    );
  const flow = flowRows[0];

  if (!flow) return null;

  const revisionRows = await client
    .select({
      id: flowRevisions.id,
      versionLabel: flowRevisions.versionLabel,
      resolvedRevision: flowRevisions.resolvedRevision,
      manifestDigest: flowRevisions.manifestDigest,
      manifest: flowRevisions.manifest,
      execTrust: flowRevisions.execTrust,
      setupStatus: flowRevisions.setupStatus,
      packageStatus: flowRevisions.packageStatus,
      installedPath: flowRevisions.installedPath,
      source: flowRevisions.source,
      installedAt: flowRevisions.installedAt,
    })
    .from(flowRevisions)
    .where(
      and(
        eq(flowRevisions.flowRefId, flow.flowRefId),
        eq(flowRevisions.source, flow.source),
        notInArray(flowRevisions.packageStatus, ["Removed"]),
      ),
    )
    .orderBy(asc(flowRevisions.installedAt));

  const revisions: FlowRevisionDetail[] = revisionRows.map((r) => ({
    id: r.id,
    versionLabel: r.versionLabel,
    resolvedRevision: r.resolvedRevision,
    manifestDigest: r.manifestDigest,
    manifest: r.manifest as FlowYamlV1,
    execTrust: r.execTrust,
    setupStatus: r.setupStatus,
    packageStatus: r.packageStatus,
    installedPath: r.installedPath,
  }));

  return {
    project,
    flow: {
      id: flow.id,
      flowRefId: flow.flowRefId,
      source: flow.source,
      enabledRevisionId: flow.enabledRevisionId,
    },
    revisions,
    dto: {
      ref: flow.flowRefId,
      version: flow.version,
      versionBinding: flow.versionBinding,
      trustStatus: flow.trustStatus,
      enablementState: flow.enablementState,
      enabledRevisionId: flow.enabledRevisionId,
      revisions: revisions.map(toRevisionDetailDTO),
    },
  };
}
