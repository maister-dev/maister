import "server-only";

import type { CompanyAction, Owner } from "@/lib/company/types";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { ProjectRole } from "@/lib/db/schema";
import type { AssignmentAuthoritySnapshot } from "./types";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";

import { sql } from "drizzle-orm";

import { projectRolesForActions } from "@/lib/authz";
import { resolveKnowledgePrincipal } from "@/lib/brain/knowledge-access";
import { MaisterError } from "@/lib/errors";

export type AssignmentAction = Extract<CompanyAction, `assignments:${string}`>;

/** Current authority is locked for this transaction; retained snapshots never authorize an action. */
export async function authorizeAssignment(
  tx: SqlTransaction,
  userId: string,
  owner: Owner,
  action: AssignmentAction,
  executionPolicy: ExecutionPolicy,
): Promise<AssignmentAuthoritySnapshot> {
  const identity = await resolveKnowledgePrincipal(
    tx,
    { kind: "user", userId },
    "knowledge:read",
  );

  if (identity.kind !== "user")
    throw new MaisterError(
      "UNAUTHORIZED",
      "A current user identity is required for assignment authority",
    );
  const base = {
    schemaVersion: 1 as const,
    capturedAt: new Date().toISOString(),
    actor: identity.actor,
    executionPolicy,
  };

  if (owner.kind === "company") {
    const grant = (
      await tx.execute(
        sql`SELECT id,revision FROM company_grants WHERE company_id=${owner.companyId} AND principal_type='user' AND principal_id=${userId} AND action=${action} AND revoked_at IS NULL FOR SHARE`,
      )
    ).rows[0];

    if (
      !grant ||
      typeof grant.id !== "string" ||
      typeof grant.revision !== "number"
    )
      throw new MaisterError(
        "UNAUTHORIZED",
        "Current explicit company assignment authority is required",
        { details: { action } },
      );

    return {
      ...base,
      witnesses: [
        {
          kind: "company_grant",
          owner,
          authorityId: grant.id,
          revision: grant.revision,
          action,
        },
      ],
    };
  }
  const project = (
    await tx.execute(
      sql`SELECT id FROM projects WHERE id=${owner.projectId} FOR SHARE`,
    )
  ).rows[0];

  if (!project)
    throw new MaisterError("PRECONDITION", "Assignment project is unavailable");
  if (identity.user.role === "admin")
    return {
      ...base,
      witnesses: [
        {
          kind: "project_administrator",
          projectId: owner.projectId,
          userId,
          role: "admin",
        },
      ],
    };
  const membership = (
    await tx.execute(
      sql`SELECT id,role FROM project_members WHERE project_id=${owner.projectId} AND user_id=${userId} FOR SHARE`,
    )
  ).rows[0] as { id: string; role: ProjectRole } | undefined;
  const roles = projectRolesForActions([
    action === "assignments:read"
      ? "readBoard"
      : action === "assignments:answer"
        ? "answerHitl"
        : action === "assignments:recover"
          ? "recoverRun"
          : "launchRun",
  ]);

  if (!membership || !roles.includes(membership.role))
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current project assignment authority is required",
      { details: { action } },
    );

  return {
    ...base,
    witnesses: [
      {
        kind: "project_membership",
        projectId: owner.projectId,
        membershipId: membership.id,
        role: membership.role,
      },
    ],
  };
}
