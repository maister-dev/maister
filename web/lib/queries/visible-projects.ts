import "server-only";

/**
 * The ONE visible-projects scope (ADR-169 D6).
 *
 * `admin` reaches every non-archived project by ROLE, not by membership;
 * everyone else reaches the non-archived projects they belong to. That branch
 * was inlined three times before this helper existed, and this milestone adds
 * five more cross-project read models — so the fourth and fifth copies are the
 * ones that never get written.
 *
 * `getVisibleProjectIds` returns ids only — callers that need more columns
 * select them themselves, which keeps their projections (and their ORDER BY)
 * where they belong. `getVisibleProjects` is the same ONE query for the two
 * surfaces that need to name the projects as well (a filter dropdown, a
 * slug-to-id lookup); duplicating the admin-versus-membership branch to build a
 * dropdown is exactly what this module exists to prevent.
 *
 * `client` is injectable because the observatory read models thread an explicit
 * handle through every query; resolving `getDb()` here instead would bypass the
 * handle they were given.
 */

import type { GlobalRole } from "@/lib/db/schema";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { projectMembers, projects } from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants — matches the handle the
// observatory read models already thread through their own query helpers.
type VisibleProjectsClient = any;

const log = pino({
  name: "queries-visible-projects",
  level: process.env.LOG_LEVEL ?? "info",
});

export interface VisibleProject {
  id: string;
  slug: string;
  name: string;
}

export async function getVisibleProjects(
  userId: string,
  globalRole: GlobalRole,
  client: VisibleProjectsClient = getDb(),
): Promise<VisibleProject[]> {
  const columns = { id: projects.id, slug: projects.slug, name: projects.name };
  const rows =
    globalRole === "admin"
      ? await client
          .select(columns)
          .from(projects)
          .where(isNull(projects.archivedAt))
      : await client
          .select(columns)
          .from(projects)
          .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
          .where(
            and(eq(projectMembers.userId, userId), isNull(projects.archivedAt)),
          );

  const visible = rows as VisibleProject[];

  log.debug(
    { userId, globalRole, visibleCount: visible.length },
    "resolved visible projects",
  );

  return visible;
}

export async function getVisibleProjectIds(
  userId: string,
  globalRole: GlobalRole,
  client: VisibleProjectsClient = getDb(),
): Promise<string[]> {
  const visible = await getVisibleProjects(userId, globalRole, client);

  return visible.map((project) => project.id);
}
