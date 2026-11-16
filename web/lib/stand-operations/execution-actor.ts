import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { CompanyAction } from "@/lib/company/types";

import { sql } from "drizzle-orm";

import {
  resolveNativeTokenPrincipal,
  type KnowledgePrincipalIdentity,
} from "@/lib/brain/knowledge-access";
import { assignmentInputReadPolicy } from "@/lib/brain/knowledge-assignment-policy";
import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { installationCompany } from "@/lib/company/grants";
import { MaisterError } from "@/lib/errors";
import { authorizeAssignment } from "@/lib/specialist-assignments/access";
import { requireProjectAssignmentInitiator } from "@/lib/specialist-assignments/project-execution-initiator";

export type StandExecutionActor = Readonly<{
  agentId: string;
  runId: string;
  nodeAttemptId: string | null;
  userId: string;
  companyId: string;
}>;

type SpecialistExecution = Exclude<
  KnowledgePrincipalIdentity,
  { kind: "user" }
>;
export type StandProfessionalAction = Extract<
  CompanyAction,
  "targets:read" | "targets:restart" | "targets:logs"
>;

export async function resolveStandCredential(
  tx: Db,
  tokenId: string,
): Promise<SpecialistExecution> {
  const identity = await resolveNativeTokenPrincipal(
    tx,
    tokenId,
    "targets:read",
  );

  if (identity.kind === "user")
    throw new MaisterError(
      "UNAUTHORIZED",
      "A current specialist execution token is required",
    );

  return identity;
}

/** Bind a stand action to the current professional, placement and exact frozen input. */
export async function resolveStandExecutionActor(
  tx: Db,
  identity: SpecialistExecution,
  assignmentId: string,
  inputRevision: number,
  action: StandProfessionalAction,
): Promise<StandExecutionActor> {
  if (
    identity.kind === "company_agent" &&
    (!identity.actionLimits.includes("assignments:read") ||
      !identity.actionLimits.includes("targets:read") ||
      !identity.actionLimits.includes(action))
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "A currently authorized specialist is required",
    );
  const { id: agentId, runId, attemptId: nodeAttemptId } = identity.actor;

  if (runId === null)
    throw new MaisterError(
      "UNAUTHORIZED",
      "A current specialist Run is required",
    );
  const companyId =
    identity.kind === "company_agent"
      ? identity.companyId
      : await installationCompany(tx);
  const appointment =
    identity.kind === "company_agent"
      ? sql`subject.company_id=${companyId} AND EXISTS (
        SELECT 1 FROM company_grants grant_row
        WHERE grant_row.company_id=${companyId} AND grant_row.principal_type='agent'
          AND grant_row.principal_id=${agentId} AND grant_row.action='assignments:read'
          AND grant_row.revoked_at IS NULL FOR SHARE)`
      : sql`subject.project_id=${identity.projectId}
        AND (${assignmentInputReadPolicy(identity, sql`subject.id`, sql`input.revision`, sql`input.digest`)})
        AND EXISTS (
          SELECT 1 FROM agents professional WHERE professional.id=${agentId}
          AND professional.specialist->'targetClasses' ? 'stand' FOR SHARE)`;
  const [allowed] = (
    await tx.execute(sql`
    SELECT subject.id FROM specialist_run_links link
    JOIN specialist_assignments subject ON subject.id=link.assignment_id
    JOIN specialist_input_revisions input ON input.assignment_id=subject.id AND input.revision=subject.input_revision
    JOIN runs execution ON execution.id=link.run_id
    WHERE subject.id=${assignmentId} AND input.revision=${inputRevision}
      AND (${appointment}) AND execution.id=${runId} AND execution.status='Running'
      AND execution.company_cancellation_intent IS NULL AND execution.budget_state->'termination' IS NULL
      AND specialist_execution_owner_epoch(execution.id)>0
      AND specialist_run_has_input(execution.id,subject.id,input.revision,input.digest)
      AND EXISTS (SELECT 1 FROM company_grants grant_row
        WHERE grant_row.company_id=${companyId} AND grant_row.principal_type='agent'
          AND grant_row.principal_id=${agentId} AND grant_row.action='targets:read' AND grant_row.revoked_at IS NULL FOR SHARE)
      AND EXISTS (SELECT 1 FROM company_grants grant_row
        WHERE grant_row.company_id=${companyId} AND grant_row.principal_type='agent'
          AND grant_row.principal_id=${agentId} AND grant_row.action=${action} AND grant_row.revoked_at IS NULL FOR SHARE)
    FOR SHARE OF subject,execution
  `)
  ).rows;

  if (!allowed)
    throw new MaisterError(
      "UNAUTHORIZED",
      "The specialist cannot act on this assignment input",
    );

  const userId =
    identity.kind === "company_agent"
      ? identity.initiatingUser.id
      : await requireProjectAssignmentInitiator(tx, identity);

  if (identity.kind === "agent") {
    await authorizeAssignment(
      tx,
      userId,
      { kind: "project", projectId: identity.projectId },
      action === "targets:restart" ? "assignments:update" : "assignments:read",
      { preset: "supervised" },
    );
  }
  await authorizeCompanyUserAction(tx, userId, companyId, "targets:read");
  if (action !== "targets:read")
    await authorizeCompanyUserAction(tx, userId, companyId, action);

  return { agentId, runId, nodeAttemptId, userId, companyId };
}
