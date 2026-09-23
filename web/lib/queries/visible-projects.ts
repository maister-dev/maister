import "server-only";

/**
 * The ONE visible-projects scope (ADR-170 D6).
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

import type { GlobalRole, ProjectRole } from "@/lib/db/schema";

import { and, eq, inArray, isNull } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { projectMembers, projects } from "@/lib/db/schema";
import { projectRolesForActions, type ProjectAction } from "@/lib/authz";

// FIXME(any): dual drizzle-orm peer-dep variants — matches the handle the
// observatory read models already thread through their own query helpers.
type VisibleProjectsClient = any;

const log = pino({
  name: "queries-visible-projects",
  level: process.env.LOG_LEVEL ?? "info",
});

/**
 * The four things a decision-queue entry can ask of a reader. The role floor is
 * derived from THESE, so raising any one of them narrows the queue with no
 * second edit — and `owner`, which ranks above `admin`, is never dropped.
 */
const DECISION_ACTIONS = [
  "answerHitl",
  "promoteRun",
  "recoverRun",
  "editTask",
] as const satisfies readonly ProjectAction[];

/**
 * Derived on CALL, never at module scope.
 *
 * `projectRolesForActions` lives in `@/lib/authz`, and calling it at module
 * scope runs it during IMPORT — so every suite that partially mocks that module
 * (many do, for `requireProjectAction`) threw
 * `No "projectRolesForActions" export is defined on the mock` before its first
 * line, wherever this module is in the import graph. That is a wide graph:
 * `portfolio.ts` and `updates.ts` both pull it in, so the throw reached route
 * handlers and surfaced as a 500. The derivation is unchanged and still the
 * single source of truth; it just no longer happens at import time. It is four
 * lookups in a rank map, called once per query.
 */
function actingProjectRoles(): ProjectRole[] {
  return projectRolesForActions(DECISION_ACTIONS);
}

/**
 * Whether EVERY reader the decision queue admits also holds `action` on the
 * item's project. Queue items are scoped to the `DECISION_ACTIONS` role floor,
 * so a surface rendering them may show an `action`-gated affordance exactly
 * when that floor clears it — derived from the same rank map, never assumed.
 */
export function decisionQueueGrants(action: ProjectAction): boolean {
  const granted = projectRolesForActions([action]);

  return actingProjectRoles().every((role) => granted.includes(role));
}

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

/**
 * The projects a reader can ACT in, not merely read (ADR-169 D7).
 *
 * `readBoard` is a `viewer` action; `answerHitl`, `promoteRun`, `recoverRun`
 * and `editTask` — the four things a decision-queue entry asks for — all
 * require `member`. Scoping the queue by VISIBILITY therefore handed viewers
 * items they cannot resolve: a promotable run they cannot promote, a crashed
 * run whose inline recover/discard answers 403. A badge that says "this needs
 * you" while the action refuses is worse than no badge, and it propagates into
 * notifications.
 *
 * A global `admin` acts everywhere by role, exactly as they see everywhere.
 */
export async function getActionableProjectIds(
  userId: string,
  globalRole: GlobalRole,
  client: VisibleProjectsClient = getDb(),
): Promise<string[]> {
  if (globalRole === "admin") {
    return getVisibleProjectIds(userId, globalRole, client);
  }

  const rows = await client
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
    .where(
      and(
        eq(projectMembers.userId, userId),
        isNull(projects.archivedAt),
        // The membership roles that clear `member` in PROJECT_ACTION_MIN_ROLE.
        // Spelled as an allow-list: a fourth project role must be classified
        // deliberately rather than inheriting act-everywhere by default.
        inArray(projectMembers.role, actingProjectRoles()),
      ),
    );

  const actionable = (rows as Array<{ id: string }>).map((row) => row.id);

  log.debug(
    { userId, globalRole, actionableCount: actionable.length },
    "resolved actionable projects",
  );

  return actionable;
}

export async function getVisibleProjectIds(
  userId: string,
  globalRole: GlobalRole,
  client: VisibleProjectsClient = getDb(),
): Promise<string[]> {
  const visible = await getVisibleProjects(userId, globalRole, client);

  return visible.map((project) => project.id);
}
