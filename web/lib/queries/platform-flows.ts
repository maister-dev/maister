import "server-only";

import type { GlobalRole } from "@/lib/db/schema";
import type { SQL } from "drizzle-orm";

import { sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";

type QueryResult = {
  rows?: unknown[];
};

type QueryDb = {
  execute(query: SQL): Promise<QueryResult>;
};

export type PlatformFlowProject = {
  id: string;
  slug: string;
  name: string;
  canManageCatalog: boolean;
};

export type PlatformInstalledFlow = {
  id: string;
  projectSlug: string;
  projectName: string;
  ref: string;
  source: string;
  version: string;
  revision: string;
  enablementState: string;
  trustStatus: string;
  enabledRevisionId: string | null;
  enabledVersionLabel: string | null;
  enabledResolvedRevision: string | null;
  packageStatus: string | null;
  setupStatus: string | null;
};

export type PlatformAuthoredFlow = {
  id: string;
  projectSlug: string;
  projectName: string;
  slug: string;
  title: string;
  lifecycle: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  draftVersion: number;
  currentDraftRevisionId: string | null;
  currentPublishedRevisionId: string | null;
  draftContentHash: string | null;
  publishedContentHash: string | null;
  updatedAt: Date;
};

export type PlatformFlowsView = {
  projects: PlatformFlowProject[];
  installed: PlatformInstalledFlow[];
  authored: PlatformAuthoredFlow[];
};

export type PlatformFlowStatusFilter =
  | "all"
  | "draft"
  | "published"
  | "archived"
  | "enabled"
  | "disabled"
  | "deprecated"
  | "discovered"
  | "failed"
  | "installed"
  | "installing"
  | "removed"
  | "update-available";

export type PlatformFlowFilters = {
  project: string;
  status: PlatformFlowStatusFilter;
};

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  role?: string;
};

type InstalledFlowRow = {
  id: string;
  project_slug: string;
  project_name: string;
  flow_ref_id: string;
  source: string;
  version: string;
  revision: string;
  enablement_state: string;
  trust_status: string;
  enabled_revision_id: string | null;
  enabled_version_label: string | null;
  enabled_resolved_revision: string | null;
  package_status: string | null;
  setup_status: string | null;
};

type AuthoredFlowRow = {
  id: string;
  project_slug: string;
  project_name: string;
  slug: string;
  title: string;
  lifecycle: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  draft_version: number;
  current_draft_revision_id: string | null;
  current_published_revision_id: string | null;
  draft_content_hash: string | null;
  published_content_hash: string | null;
  updated_at: Date | string;
};

export async function getPlatformFlows(args: {
  userId: string;
  userRole: GlobalRole;
  filters?: PlatformFlowFilters;
}): Promise<PlatformFlowsView> {
  // FIXME(any): getDb() returns a pg|sqlite drizzle union; this query module
  // keeps the existing raw-SQL seam until the installed package read model can
  // be shared across cross-project views. Re-check the db.execute()->rows shape
  // before relying on this helper in the SQLite dev dialect.
  const db = getDb() as unknown as QueryDb;
  const projects = await listAccessibleProjects(db, args);

  if (projects.length === 0) {
    return { projects: [], installed: [], authored: [] };
  }

  const projectIds = projects.map((project) => project.id);
  const [installed, authored] = await Promise.all([
    listInstalledFlows(db, projectIds),
    listAuthoredFlows(db, projectIds),
  ]);

  return filterPlatformFlows(
    { projects, installed, authored },
    args.filters ?? DEFAULT_PLATFORM_FLOW_FILTERS,
  );
}

// Viewer-visible projects (admin → all non-archived; member → projects they
// belong to), each tagged with `canManageCatalog`. Shared by Studio surfaces
// that gather cross-project package attachments and gate manage actions.
export async function getAccessibleProjects(
  userId: string,
  userRole: GlobalRole,
): Promise<PlatformFlowProject[]> {
  const db = getDb() as unknown as QueryDb;

  return listAccessibleProjects(db, { userId, userRole });
}

const DEFAULT_PLATFORM_FLOW_FILTERS: PlatformFlowFilters = {
  project: "all",
  status: "all",
};

const STATUS_FILTERS = new Set<PlatformFlowStatusFilter>([
  "all",
  "draft",
  "published",
  "archived",
  "enabled",
  "disabled",
  "deprecated",
  "discovered",
  "failed",
  "installed",
  "installing",
  "removed",
  "update-available",
]);

export function parsePlatformFlowSearchParams(
  searchParams: Record<string, string | string[] | undefined>,
): PlatformFlowFilters {
  const project = firstParam(searchParams.project)?.trim() || "all";
  const rawStatus = firstParam(searchParams.status)?.trim() ?? "all";
  const status = STATUS_FILTERS.has(rawStatus as PlatformFlowStatusFilter)
    ? (rawStatus as PlatformFlowStatusFilter)
    : "all";

  return { project, status };
}

export function filterPlatformFlows(
  view: PlatformFlowsView,
  filters: PlatformFlowFilters,
): PlatformFlowsView {
  const projectMatches = (projectSlug: string): boolean =>
    filters.project === "all" || projectSlug === filters.project;

  return {
    projects: view.projects,
    authored: view.authored.filter(
      (flow) =>
        projectMatches(flow.projectSlug) &&
        authoredMatches(flow, filters.status),
    ),
    installed: view.installed.filter(
      (flow) =>
        projectMatches(flow.projectSlug) &&
        installedMatches(flow, filters.status),
    ),
  };
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function authoredMatches(
  flow: PlatformAuthoredFlow,
  status: PlatformFlowStatusFilter,
): boolean {
  if (status === "all") return true;
  if (status === "draft") return flow.lifecycle === "DRAFT";
  if (status === "published") return flow.lifecycle === "PUBLISHED";
  if (status === "archived") return flow.lifecycle === "ARCHIVED";

  return false;
}

function installedMatches(
  flow: PlatformInstalledFlow,
  status: PlatformFlowStatusFilter,
): boolean {
  if (status === "all") return true;
  if (status === "installed") {
    return (
      flow.enablementState === "Installed" || flow.packageStatus === "Installed"
    );
  }
  if (status === "enabled") return flow.enablementState === "Enabled";
  if (status === "disabled") return flow.enablementState === "Disabled";
  if (status === "deprecated") return flow.enablementState === "Deprecated";
  if (status === "discovered") return flow.packageStatus === "Discovered";
  if (status === "installing") return flow.packageStatus === "Installing";
  if (status === "removed") return flow.packageStatus === "Removed";
  if (status === "update-available") {
    return flow.enablementState === "UpdateAvailable";
  }
  if (status === "failed") {
    return (
      flow.enablementState === "Failed" ||
      flow.packageStatus === "Failed" ||
      flow.setupStatus === "failed"
    );
  }

  return false;
}

async function listAccessibleProjects(
  db: QueryDb,
  args: { userId: string; userRole: GlobalRole },
): Promise<PlatformFlowProject[]> {
  const result =
    args.userRole === "admin"
      ? await db.execute(sql`
        SELECT id, slug, name
          FROM projects
          WHERE archived_at IS NULL
          ORDER BY name ASC
        `)
      : await db.execute(sql`
          SELECT p.id, p.slug, p.name, pm.role
          FROM projects p
          INNER JOIN project_members pm ON pm.project_id = p.id
          WHERE p.archived_at IS NULL
            AND pm.user_id = ${args.userId}
          ORDER BY p.name ASC
        `);

  return rowsOf<ProjectRow>(result).map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    canManageCatalog:
      args.userRole === "admin" || row.role === "admin" || row.role === "owner",
  }));
}

async function listInstalledFlows(
  db: QueryDb,
  projectIds: string[],
): Promise<PlatformInstalledFlow[]> {
  const result = await db.execute(sql`
    SELECT
      f.id,
      p.slug AS project_slug,
      p.name AS project_name,
      f.flow_ref_id,
      f.source,
      f.version,
      f.revision,
      f.enablement_state,
      f.trust_status,
      f.enabled_revision_id,
      fr.version_label AS enabled_version_label,
      fr.resolved_revision AS enabled_resolved_revision,
      fr.package_status,
      fr.setup_status
    FROM flows f
    INNER JOIN projects p ON p.id = f.project_id
    LEFT JOIN flow_revisions fr ON fr.id = f.enabled_revision_id
    WHERE f.project_id IN (${sql.join(
      projectIds.map((id) => sql`${id}`),
      sql`,`,
    )})
    ORDER BY p.name ASC, f.flow_ref_id ASC
  `);

  return rowsOf<InstalledFlowRow>(result).map((row) => ({
    id: row.id,
    projectSlug: row.project_slug,
    projectName: row.project_name,
    ref: row.flow_ref_id,
    source: row.source,
    version: row.version,
    revision: row.revision,
    enablementState: row.enablement_state,
    trustStatus: row.trust_status,
    enabledRevisionId: row.enabled_revision_id,
    enabledVersionLabel: row.enabled_version_label,
    enabledResolvedRevision: row.enabled_resolved_revision,
    packageStatus: row.package_status,
    setupStatus: row.setup_status,
  }));
}

async function listAuthoredFlows(
  db: QueryDb,
  projectIds: string[],
): Promise<PlatformAuthoredFlow[]> {
  const result = await db.execute(sql`
    SELECT
      ac.id,
      p.slug AS project_slug,
      p.name AS project_name,
      ac.slug,
      ac.title,
      ac.lifecycle,
      ac.draft_version,
      ac.current_draft_revision_id,
      ac.current_published_revision_id,
      draft.content_hash AS draft_content_hash,
      published.content_hash AS published_content_hash,
      ac.updated_at
    FROM authored_capabilities ac
    INNER JOIN projects p ON p.id = ac.project_id
    LEFT JOIN authored_capability_revisions draft
      ON draft.id = ac.current_draft_revision_id
    LEFT JOIN authored_capability_revisions published
      ON published.id = ac.current_published_revision_id
    WHERE ac.kind = 'flow'
      AND ac.project_id IN (${sql.join(
        projectIds.map((id) => sql`${id}`),
        sql`,`,
      )})
    ORDER BY p.name ASC, ac.slug ASC
  `);

  return rowsOf<AuthoredFlowRow>(result).map((row) => ({
    id: row.id,
    projectSlug: row.project_slug,
    projectName: row.project_name,
    slug: row.slug,
    title: row.title,
    lifecycle: row.lifecycle,
    draftVersion: row.draft_version,
    currentDraftRevisionId: row.current_draft_revision_id,
    currentPublishedRevisionId: row.current_published_revision_id,
    draftContentHash: row.draft_content_hash,
    publishedContentHash: row.published_content_hash,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at
        : new Date(row.updated_at),
  }));
}

function rowsOf<T>(result: QueryResult): T[] {
  return (result.rows ?? []) as T[];
}
