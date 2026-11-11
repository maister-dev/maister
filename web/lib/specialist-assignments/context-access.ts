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
import type { AssignmentAuthoritySnapshot } from "./types";

import { sql } from "drizzle-orm";

import { projectAssignmentInitiatorPolicy } from "./project-initiator-policy";
import { authorizeAssignment } from "./access";

import {
  resolveKnowledgePrincipal,
  resolveNativeTokenPrincipal,
} from "@/lib/brain/knowledge-access";
import { lockKnowledgeReadConsumer } from "@/lib/brain/knowledge-disclosure";
import { assignmentInputReadPolicy } from "@/lib/brain/knowledge-assignment-policy";
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
type CurrentAssignmentAction = Readonly<{
  authority: AssignmentAuthoritySnapshot & { actor: KnowledgeAuthorityActor };
  executionEpoch: number | null;
  ownerEpoch: number | null;
}>;

function fencedAssignmentOwner(): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "Assignment mutation requires its active execution owner",
    { details: { reason: "assignment_fenced" } },
  );
}

/** Lock the actual consuming Run before source reads; a credential never becomes its initiating human. */
export async function resolveAssignmentContextPrincipal(
  tx: SqlTransaction,
  principal: AssignmentContextPrincipal,
  scope: "assignments:read" | "assignments:update" | "assignments:accept",
): Promise<ResolvedAssignmentContextPrincipal> {
  const consumer = await lockKnowledgeReadConsumer(tx, principal);
  const identity =
    principal.kind === "user"
      ? await resolveKnowledgePrincipal(tx, principal, "knowledge:read")
      : await resolveNativeTokenPrincipal(tx, principal.tokenId, scope);

  if (principal.kind === "token" && scope !== "assignments:read")
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
): Promise<CurrentAssignmentAction> {
  return authorizeAssignmentExecutionAction(
    tx,
    principal,
    owner,
    policy,
    "assignments:update",
  );
}

/** A delegate action needs current initiating and professional authority for the same appointment. */
export async function authorizeAssignmentDelegation(
  tx: SqlTransaction,
  principal: ResolvedAssignmentContextPrincipal,
  owner: Owner,
  policy: ExecutionPolicy,
): Promise<AssignmentAuthoritySnapshot> {
  if (principal.identity.kind === "user")
    throw new MaisterError(
      "UNAUTHORIZED",
      "Delegation requires the current originating professional execution",
    );

  const action = await authorizeAssignmentExecutionAction(
    tx,
    principal,
    owner,
    policy,
    "assignments:delegate",
  );

  return action.authority;
}

export async function authorizeAssignmentWorkAcceptance(
  tx: SqlTransaction,
  principal: ResolvedAssignmentContextPrincipal,
  owner: Owner,
  policy: ExecutionPolicy,
): Promise<CurrentAssignmentAction> {
  return authorizeAssignmentExecutionAction(
    tx,
    principal,
    owner,
    policy,
    "assignments:accept",
  );
}

async function authorizeAssignmentExecutionAction(
  tx: SqlTransaction,
  principal: ResolvedAssignmentContextPrincipal,
  owner: Owner,
  executionPolicy: ExecutionPolicy,
  action: "assignments:update" | "assignments:delegate" | "assignments:accept",
): Promise<CurrentAssignmentAction> {
  const executionEpoch =
    principal.identity.kind === "user"
      ? null
      : await lockAssignmentExecutionEpoch(
          tx,
          principal.identity.actor.runId,
          action,
        );
  const ownerEpoch =
    principal.identity.kind === "user"
      ? null
      : await readAssignmentOwnerEpoch(tx, principal.identity.actor.runId);
  const authority = await authorizeAssignmentActionGrants(
    tx,
    principal,
    owner,
    executionPolicy,
    action,
  );

  return { authority, executionEpoch, ownerEpoch };
}

async function readAssignmentOwnerEpoch(
  tx: SqlTransaction,
  runId: string | null,
): Promise<number | null> {
  const [claim] = (
    await tx.execute(
      sql`SELECT specialist_execution_owner_epoch(${runId}) AS epoch`,
    )
  ).rows;

  if (claim?.epoch === null) return null;
  if (typeof claim?.epoch !== "number" || claim.epoch < 1)
    throw fencedAssignmentOwner();

  return claim.epoch;
}

/** The retained question owns checkpoint activation and replay after placement is released. */
export async function authorizeRetainedAssignmentQuestion(
  tx: SqlTransaction,
  principal: ResolvedAssignmentContextPrincipal,
  owner: Owner,
  policy: ExecutionPolicy,
): Promise<void> {
  await authorizeAssignmentActionGrants(
    tx,
    principal,
    owner,
    policy,
    "assignments:update",
  );
}

async function lockAssignmentExecutionEpoch(
  tx: SqlTransaction,
  runId: string | null,
  action: "assignments:update" | "assignments:delegate" | "assignments:accept",
): Promise<number | null> {
  const active = (
    await tx.execute(
      sql`SELECT execution_assignment_id,execution_assignment_id IS NULL AND EXISTS (
        SELECT 1 FROM execution_assignments placement WHERE placement.run_id=runs.id
      ) AS lost_execution_owner FROM runs WHERE id=${runId}
        AND ${
          action === "assignments:accept"
            ? sql`status='Running'`
            : sql`status IN ('Running','NeedsInput','NeedsInputIdle','WaitingOnChildren')`
        }
        FOR SHARE`,
    )
  ).rows[0];

  if (!active)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Assignment mutation requires the current active execution",
    );

  if (active.lost_execution_owner === true) throw fencedAssignmentOwner();
  if (active.execution_assignment_id !== null) {
    const [placement] = (
      await tx.execute(sql`
        SELECT epoch FROM execution_assignments
        WHERE id=${active.execution_assignment_id} AND run_id=${runId}
          AND state='active' AND (lease_expires_at IS NULL OR lease_expires_at>clock_timestamp())
        FOR SHARE
      `)
    ).rows;

    if (typeof placement?.epoch !== "number") throw fencedAssignmentOwner();

    return placement.epoch;
  }

  return null;
}

async function authorizeAssignmentActionGrants(
  tx: SqlTransaction,
  principal: ResolvedAssignmentContextPrincipal,
  owner: Owner,
  executionPolicy: ExecutionPolicy,
  action: "assignments:update" | "assignments:delegate" | "assignments:accept",
): Promise<CurrentAssignmentAction["authority"]> {
  const { identity } = principal;

  if (identity.kind === "user")
    return {
      ...(await authorizeAssignment(
        tx,
        identity.user.id,
        owner,
        action,
        executionPolicy,
      )),
      actor: identity.actor,
    };
  if (identity.kind === "company_agent") {
    if (
      owner.kind !== "company" ||
      owner.companyId !== identity.companyId ||
      !identity.actionLimits.includes(action)
    )
      throw new MaisterError(
        "UNAUTHORIZED",
        "The current company role does not permit the assignment action",
      );
    const initiatingAuthority = await authorizeCompanyUserAction(
      tx,
      identity.initiatingUser.id,
      owner.companyId,
      action,
    );
    const grant = (
      await tx.execute(
        sql`SELECT id,revision FROM company_grants WHERE company_id=${owner.companyId} AND principal_type='agent' AND principal_id=${identity.actor.id} AND action=${action} AND revoked_at IS NULL FOR SHARE`,
      )
    ).rows[0];

    if (typeof grant?.id !== "string" || typeof grant.revision !== "number")
      throw new MaisterError(
        "UNAUTHORIZED",
        "Current explicit professional assignment authority is required",
      );

    return {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      actor: identity.actor,
      executionPolicy,
      witnesses: [
        initiatingAuthority.witness,
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
        AND ((appointment.work_id IS NULL AND (${projectAssignmentInitiatorPolicy(
          {
            runId: sql`execution.id`,
            createdByUserId: sql`execution.created_by_user_id`,
            projectId: sql`execution.project_id`,
            taskId: sql`execution.task_id`,
            userId: sql`original.actor->>'id'`,
            assignmentId: sql`original.assignment_id`,
            inputRevision: sql`original.revision`,
            inputSha256: sql`original.digest`,
          },
        )})) OR (appointment.work_id IS NOT NULL AND (${assignmentInputReadPolicy(
          identity,
          sql`original.assignment_id`,
          sql`original.revision`,
          sql`original.digest`,
        )})))
      FOR SHARE OF execution,appointment,requested,original`,
    )
  ).rows[0];

  if (typeof run?.initiating_user_id !== "string")
    throw new MaisterError(
      "UNAUTHORIZED",
      "The current initiating project principal is unavailable",
    );

  return {
    ...(await authorizeAssignment(
      tx,
      run.initiating_user_id,
      owner,
      action,
      executionPolicy,
    )),
    actor: identity.actor,
  };
}
