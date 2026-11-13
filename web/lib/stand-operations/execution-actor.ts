import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { CompanyAction } from "@/lib/company/types";

import { sql } from "drizzle-orm";

import {
  resolveNativeTokenPrincipal,
  type KnowledgePrincipalIdentity,
} from "@/lib/brain/knowledge-access";
import { MaisterError } from "@/lib/errors";

export type StandExecutionActor = Readonly<{
  agentId: string;
  runId: string;
  nodeAttemptId: string | null;
  userId: string;
  companyId: string;
}>;

type CompanyExecution = Extract<
  KnowledgePrincipalIdentity,
  { kind: "company_agent" }
>;

export async function resolveStandCredential(
  tx: Db,
  tokenId: string,
): Promise<CompanyExecution> {
  const identity = await resolveNativeTokenPrincipal(
    tx,
    tokenId,
    "targets:read",
  );

  if (identity.kind !== "company_agent")
    throw new MaisterError(
      "UNAUTHORIZED",
      "A current specialist execution token is required",
    );

  return identity;
}

/** Bind a stand tool to the current token, specialist appointment and exact frozen input. */
export async function resolveStandExecutionActor(
  tx: Db,
  identity: CompanyExecution,
  assignmentId: string,
  inputRevision: number,
  action: Extract<
    CompanyAction,
    "targets:read" | "targets:restart" | "targets:logs"
  >,
): Promise<StandExecutionActor> {
  if (
    !identity.actionLimits.includes("assignments:read") ||
    !identity.actionLimits.includes("targets:read") ||
    !identity.actionLimits.includes(action)
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "A currently authorized company specialist is required",
    );
  const { id: agentId, runId, attemptId: nodeAttemptId } = identity.actor;
  const [allowed] = (
    await tx.execute(sql`
    SELECT subject.id FROM specialist_run_links link
    JOIN specialist_assignments subject ON subject.id=link.assignment_id
    JOIN specialist_input_revisions input ON input.assignment_id=subject.id AND input.revision=subject.input_revision
    JOIN runs execution ON execution.id=link.run_id
    WHERE subject.id=${assignmentId} AND input.revision=${inputRevision}
      AND subject.company_id=${identity.companyId} AND execution.id=${runId} AND execution.status='Running'
      AND execution.company_cancellation_intent IS NULL AND execution.budget_state->'termination' IS NULL
      AND specialist_execution_owner_epoch(execution.id)>0
      AND specialist_run_has_input(execution.id,subject.id,input.revision,input.digest)
      AND EXISTS (SELECT 1 FROM company_grants grant_row
        WHERE grant_row.company_id=subject.company_id AND grant_row.principal_type='agent'
          AND grant_row.principal_id=${agentId} AND grant_row.action='assignments:read' AND grant_row.revoked_at IS NULL FOR SHARE)
      AND EXISTS (SELECT 1 FROM company_grants grant_row
        WHERE grant_row.company_id=subject.company_id AND grant_row.principal_type='agent'
          AND grant_row.principal_id=${agentId} AND grant_row.action='targets:read' AND grant_row.revoked_at IS NULL FOR SHARE)
      AND EXISTS (SELECT 1 FROM company_grants grant_row
        WHERE grant_row.company_id=subject.company_id AND grant_row.principal_type='agent'
          AND grant_row.principal_id=${agentId} AND grant_row.action=${action} AND grant_row.revoked_at IS NULL FOR SHARE)
    FOR SHARE OF subject,execution
  `)
  ).rows;

  if (!allowed)
    throw new MaisterError(
      "UNAUTHORIZED",
      "The specialist cannot act on this assignment input",
    );

  return {
    agentId,
    runId,
    nodeAttemptId,
    userId: identity.initiatingUser.id,
    companyId: identity.companyId,
  };
}
