import "server-only";

import type { KnowledgePrincipal } from "@/lib/brain/knowledge-types";
import type {
  KnowledgePrincipalIdentity,
  KnowledgeAuthorityActor,
} from "@/lib/brain/knowledge-access";
import type { KnowledgeReadConsumer } from "@/lib/brain/knowledge-disclosure";
import type { Owner } from "@/lib/company/types";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";

import { sql } from "drizzle-orm";

import { projectAssignmentInitiatorPolicy } from "./project-initiator-policy";
import { authorizeAssignment } from "./access";

import {
  resolveKnowledgePrincipal,
  resolveNativeTokenPrincipal,
} from "@/lib/brain/knowledge-access";
import { lockKnowledgeReadConsumer } from "@/lib/brain/knowledge-disclosure";
import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { MaisterError } from "@/lib/errors";

export type AssignmentContextPrincipal = Extract<
  KnowledgePrincipal,
  { kind: "user" | "token" }
>;
export type ResolvedAssignmentContextPrincipal = Readonly<{
  identity: KnowledgePrincipalIdentity;
  source: Extract<KnowledgePrincipal, { kind: "user" | "execution" }>;
  consumer: KnowledgeReadConsumer;
}>;

/** Lock the actual consuming Run before source reads; a credential never becomes its initiating human. */
export async function resolveAssignmentContextPrincipal(
  tx: SqlTransaction,
  principal: AssignmentContextPrincipal,
  scope: "assignments:read" | "assignments:update",
): Promise<ResolvedAssignmentContextPrincipal> {
  const consumer = await lockKnowledgeReadConsumer(tx, principal);
  const identity =
    principal.kind === "user"
      ? await resolveKnowledgePrincipal(tx, principal, "knowledge:read")
      : await resolveNativeTokenPrincipal(tx, principal.tokenId, scope);

  if (principal.kind === "token" && scope === "assignments:update")
    await resolveNativeTokenPrincipal(
      tx,
      principal.tokenId,
      "assignments:read",
    );
  if (identity.kind === "user") {
    if (identity.boundProjectId !== null)
      throw new MaisterError(
        "UNAUTHORIZED",
        "Context user clients require a global personal credential",
      );

    return {
      identity,
      consumer,
      source: { kind: "user", userId: identity.user.id },
    };
  }
  if (identity.actor.runId === null)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Context requires its exact executing Run",
    );

  return {
    identity,
    consumer,
    source: {
      kind: "execution",
      runId: identity.actor.runId,
      nodeAttemptId: identity.actor.attemptId,
    },
  };
}

/** Appointment/source validation is separate; mutation additionally requires current initiating and professional authority. */
export async function authorizeAssignmentContextUpdate(
  tx: SqlTransaction,
  principal: ResolvedAssignmentContextPrincipal,
  owner: Owner,
  policy: ExecutionPolicy,
): Promise<KnowledgeAuthorityActor> {
  const { identity } = principal;

  if (identity.kind === "user") {
    await authorizeAssignment(
      tx,
      identity.user.id,
      owner,
      "assignments:update",
      policy,
    );

    return identity.actor;
  }
  const active = (
    await tx.execute(
      sql`SELECT id FROM runs WHERE id=${identity.actor.runId} AND status IN ('Running','NeedsInput','NeedsInputIdle','WaitingOnChildren') FOR SHARE`,
    )
  ).rows[0];

  if (!active)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Context mutation requires the current active execution, not a queued or reviewed Run",
    );
  if (identity.kind === "company_agent") {
    if (
      owner.kind !== "company" ||
      owner.companyId !== identity.companyId ||
      !identity.actionLimits.includes("assignments:update")
    )
      throw new MaisterError(
        "UNAUTHORIZED",
        "The current company role does not permit working context updates",
      );
    await authorizeCompanyUserAction(
      tx,
      identity.initiatingUser.id,
      owner.companyId,
      "assignments:update",
    );
    const grant = (
      await tx.execute(
        sql`SELECT id FROM company_grants WHERE company_id=${owner.companyId} AND principal_type='agent' AND principal_id=${identity.actor.id} AND action='assignments:update' AND revoked_at IS NULL FOR SHARE`,
      )
    ).rows[0];

    if (!grant)
      throw new MaisterError(
        "UNAUTHORIZED",
        "Current explicit professional context update authority is required",
      );

    return identity.actor;
  }
  if (owner.kind !== "project" || owner.projectId !== identity.projectId)
    throw new MaisterError(
      "UNAUTHORIZED",
      "The executing role does not own this project appointment",
    );
  const run = (
    await tx.execute(
      sql`SELECT original.actor->>'id' AS initiating_user_id
      FROM runs execution JOIN specialist_run_links appointment ON appointment.run_id=execution.id
      JOIN specialist_assignments requested ON requested.id=appointment.assignment_id
      JOIN specialist_input_revisions original ON original.assignment_id=appointment.assignment_id AND original.revision=appointment.input_revision
      WHERE execution.id=${identity.actor.runId} AND execution.project_id=${owner.projectId} AND execution.company_id IS NULL
        AND requested.project_id=execution.project_id AND requested.company_id IS NULL
        AND original.actor->>'kind'='user'
        AND (${projectAssignmentInitiatorPolicy({
          runId: sql`execution.id`,
          createdByUserId: sql`execution.created_by_user_id`,
          projectId: sql`execution.project_id`,
          taskId: sql`execution.task_id`,
          userId: sql`original.actor->>'id'`,
          assignmentId: sql`original.assignment_id`,
          inputRevision: sql`original.revision`,
          inputSha256: sql`original.digest`,
        })})
      FOR SHARE OF execution,appointment,requested,original`,
    )
  ).rows[0];

  if (typeof run?.initiating_user_id !== "string")
    throw new MaisterError(
      "UNAUTHORIZED",
      "The current initiating project principal is unavailable",
    );
  await authorizeAssignment(
    tx,
    run.initiating_user_id,
    owner,
    "assignments:update",
    policy,
  );

  return identity.actor;
}
