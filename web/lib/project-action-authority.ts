import "server-only";

import type { ProjectAction } from "@/lib/authz";
import type { Db } from "@/lib/execution-host/db";

import { sql } from "drizzle-orm";

import { projectRolesForActions } from "@/lib/authz";

type Connection = Pick<Db, "execute">;

/** Lock actor, project and required membership for the action's transaction. */
async function lockProjectGrant(
  db: Connection,
  projectId: string,
  userId: string,
  actions: readonly ProjectAction[],
  availability: ReturnType<typeof sql>,
): Promise<boolean> {
  const allowed = await db.execute<{
    role: string;
  }>(sql`SELECT u.role FROM users u JOIN projects p ON p.id=${projectId}
    WHERE u.id=${userId} AND u.account_status='active' AND NOT u.must_change_password
    AND ${availability} FOR SHARE OF u,p`);

  if (!allowed.rows.length) return false;
  if (allowed.rows[0].role === "admin") return true;
  const roles = projectRolesForActions(actions);
  const membership = await db.execute(sql`SELECT id FROM project_members
    WHERE project_id=${projectId} AND user_id=${userId} AND role IN ${roles} FOR SHARE`);

  return membership.rows.length > 0;
}

export function lockProjectReadGrant(
  db: Connection,
  projectId: string,
  userId: string,
): Promise<boolean> {
  return lockProjectGrant(db, projectId, userId, ["readBoard"], sql`TRUE`);
}

export function lockProjectWriteGrant(
  db: Connection,
  projectId: string,
  userId: string,
  actions: readonly ProjectAction[],
): Promise<boolean> {
  return lockProjectGrant(
    db,
    projectId,
    userId,
    actions,
    sql`p.archived_at IS NULL`,
  );
}
