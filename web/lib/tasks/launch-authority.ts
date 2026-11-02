import "server-only";

import type { ProjectAction } from "@/lib/authz";
import type { Db } from "@/lib/execution-host/db";

import { sql, type SQL } from "drizzle-orm";

import { projectRolesForActions } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";

function taskLaunchUserGrant(userId: string): SQL {
  return sql`u.id=${userId} AND u.account_status='active' AND NOT u.must_change_password`;
}

function launchAuthorityRevoked(): MaisterError {
  return new MaisterError(
    "UNAUTHORIZED",
    "Current project permission is required",
    {
      details: { reason: "launch_authority_revoked" },
    },
  );
}

async function lockTaskLaunchMembership(
  db: Db,
  projectId: string,
  userId: string,
  actions: readonly ProjectAction[],
  globalRole: string,
): Promise<void> {
  if (globalRole === "admin") return;
  const roles = projectRolesForActions(actions);
  const membership = await db.execute(sql`SELECT id FROM project_members
    WHERE project_id=${projectId} AND user_id=${userId} AND role IN ${roles} FOR SHARE`);

  if (!membership.rows.length) throw launchAuthorityRevoked();
}

/** Metadata remains readable after archival; launch availability applies only to writes. */
export async function assertTaskLaunchReadAuthority(
  db: Db,
  projectId: string,
  userId: string,
): Promise<void> {
  const allowed = await db.execute<{
    role: string;
  }>(sql`SELECT u.role FROM users u JOIN projects p ON p.id=${projectId}
    WHERE ${taskLaunchUserGrant(userId)} FOR SHARE OF u,p`);

  if (!allowed.rows.length) throw launchAuthorityRevoked();
  await lockTaskLaunchMembership(
    db,
    projectId,
    userId,
    ["readBoard"],
    allowed.rows[0].role,
  );
}

/** Keep the durable actor and project grants stable through the admitting transaction. */
export async function assertTaskLaunchUserAuthority(
  db: Db,
  projectId: string,
  userId: string,
  actions: readonly ProjectAction[],
): Promise<void> {
  const allowed = await db.execute<{
    role: string;
  }>(sql`SELECT u.role FROM users u JOIN projects p ON p.id=${projectId}
    WHERE ${taskLaunchUserGrant(userId)} AND p.archived_at IS NULL FOR SHARE OF u,p`);

  if (!allowed.rows.length) throw launchAuthorityRevoked();
  await lockTaskLaunchMembership(
    db,
    projectId,
    userId,
    actions,
    allowed.rows[0].role,
  );
}
