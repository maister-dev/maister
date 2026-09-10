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
 * Returns ids only. Callers that need columns select them themselves, which
 * keeps their projections (and their ORDER BY) where they belong.
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

export async function getVisibleProjectIds(
  userId: string,
  globalRole: GlobalRole,
  client: VisibleProjectsClient = getDb(),
): Promise<string[]> {
  const rows =
    globalRole === "admin"
      ? await client
          .select({ id: projects.id })
          .from(projects)
          .where(isNull(projects.archivedAt))
      : await client
          .select({ id: projects.id })
          .from(projects)
          .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
          .where(
            and(eq(projectMembers.userId, userId), isNull(projects.archivedAt)),
          );

  const ids = (rows as Array<{ id: string }>).map((row) => row.id);

  log.debug(
    { userId, globalRole, visibleCount: ids.length },
    "resolved visible projects",
  );

  return ids;
}
