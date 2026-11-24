import "server-only";

import type { ProjectAction } from "@/lib/authz";
import type { Db } from "@/lib/execution-host/db";

import { MaisterError } from "@/lib/errors";
import {
  lockProjectReadGrant,
  lockProjectWriteGrant,
} from "@/lib/project-action-authority";

function launchAuthorityRevoked(): MaisterError {
  return new MaisterError(
    "UNAUTHORIZED",
    "Current project permission is required",
    {
      details: { reason: "launch_authority_revoked" },
    },
  );
}

/** Metadata remains readable after archival; launch availability applies only to writes. */
export async function assertTaskLaunchReadAuthority(
  db: Db,
  projectId: string,
  userId: string,
): Promise<void> {
  if (!(await lockProjectReadGrant(db, projectId, userId)))
    throw launchAuthorityRevoked();
}

/** Keep the durable actor and project grants stable through the admitting transaction. */
export async function assertTaskLaunchUserAuthority(
  db: Pick<Db, "execute">,
  projectId: string,
  userId: string,
  actions: readonly ProjectAction[],
): Promise<void> {
  if (!(await lockProjectWriteGrant(db, projectId, userId, actions)))
    throw launchAuthorityRevoked();
}
