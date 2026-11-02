import "server-only";

import type { ProjectAction } from "@/lib/authz";
import type { Db } from "@/lib/execution-host/db";

import { sql, type SQL } from "drizzle-orm";

import { projectRolesForActions } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";

function taskLaunchUserGrant(
  userId: string,
  actions: readonly ProjectAction[],
): SQL {
  const roles = projectRolesForActions(actions);

  return sql`u.id=${userId} AND u.account_status='active' AND NOT u.must_change_password
    AND (u.role='admin' OR EXISTS(SELECT 1 FROM project_members membership
      WHERE membership.project_id=p.id AND membership.user_id=u.id AND membership.role IN ${roles}))`;
}

/** Metadata remains readable after archival; launch availability applies only to writes. */
export async function assertTaskLaunchReadAuthority(
  db: Db,
  projectId: string,
  userId: string,
): Promise<void> {
  const allowed =
    await db.execute(sql`SELECT u.id FROM users u JOIN projects p ON p.id=${projectId}
    WHERE ${taskLaunchUserGrant(userId, ["readBoard"])} FOR SHARE OF u,p`);

  if (!allowed.rows.length)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current project read permission is required",
      {
        details: { reason: "launch_authority_revoked" },
      },
    );
}

/** Keep the durable actor and project grants stable through the admitting transaction. */
export async function assertTaskLaunchUserAuthority(
  db: Db,
  projectId: string,
  userId: string,
  actions: readonly ProjectAction[],
): Promise<void> {
  const allowed =
    await db.execute(sql`SELECT u.id FROM users u JOIN projects p ON p.id=${projectId}
    WHERE ${taskLaunchUserGrant(userId, actions)} AND p.archived_at IS NULL FOR SHARE OF u,p`);

  if (!allowed.rows.length)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current project launch permission is required",
      {
        details: { reason: "launch_authority_revoked" },
      },
    );
}
