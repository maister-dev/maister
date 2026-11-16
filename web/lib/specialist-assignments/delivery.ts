import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { AssignmentResultWitness } from "./delivery-types";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { authorizeAssignment } from "./access";
import { assignmentResultWitnessSchema } from "./delivery-types";
import { beginAssignmentTransaction } from "./store";
import { validateAssignmentDestination } from "./destination";

import { projectRolesForActions } from "@/lib/authz";
import { authorizeSourceRestrictions } from "@/lib/brain/knowledge-restrictions";
import { MaisterError } from "@/lib/errors";
import { executionPolicySchema } from "@/lib/runs/execution-policy";
import { addTaskComment } from "@/lib/social/comments";

export type AuthorizedAssignmentDelivery = Readonly<{
  id: string;
  snapshot: AssignmentResultWitness;
  projectTaskId: string | null;
}>;

/** Quiet healthy inspections and observations already routed to an incident stay in assignment history. */
export async function isQuietScheduledStandDelivery(
  tx: SqlTransaction,
  deliveryId: string,
): Promise<boolean> {
  const [row] = (
    await tx.execute(sql`
    SELECT assignment.origin->>'kind'='schedule'
      AND EXISTS (
        SELECT 1 FROM agent_trigger_attempts invocation
        JOIN stand_operations operation ON operation.assignment_id=assignment.id
          AND operation.input_revision=input.revision AND operation.input_sha256=input.digest
          AND operation.action='inspect' AND operation.effect_state='not_dispatched'
          AND operation.target_id=invocation.stand_inspection->>'targetId'
          AND operation.component_id=invocation.stand_inspection->>'componentId'
          AND to_jsonb(operation.config_revision)=invocation.stand_inspection->'configRevision'
          AND operation.target_incarnation=invocation.stand_inspection->>'incarnationId'
        JOIN stand_verifications probe ON probe.operation_id=operation.id AND probe.effect_receipt_id IS NULL
        WHERE invocation.id=assignment.origin->>'triggerAttemptId'
          AND invocation.schedule_id=assignment.origin->>'scheduleId'
          AND (result.value->'operationIds') ? operation.id AND (result.value->'verificationIds') ? probe.id
          AND NOT EXISTS (
            SELECT 1 FROM stand_verifications later WHERE later.operation_id=operation.id
              AND later.target_sequence>probe.target_sequence
          )
          AND (
            (probe.state='healthy' AND result.value->>'outcome'='success'
              AND result.value->'coverage'->>'state'='complete'
              AND result.value->'diagnostics'='[]'::jsonb
              AND result.value->'findings'->'findings'='[]'::jsonb
              AND result.value->'findings'->'knowledgeProposals'='[]'::jsonb)
            OR (probe.state<>'healthy' AND result.value->>'outcome' IN ('blocked','failed')
              AND EXISTS (
                SELECT 1 FROM stand_incident_episodes episode
                JOIN inbox_items notice ON notice.stand_incident_id=episode.id
                  AND notice.event_kind='stand_incident_opened'
                  AND notice.recipient_id=assignment.requester->>'id'
                WHERE episode.resource_key=operation.resource_key
                  AND episode.reason='verification_'||probe.state
                  AND probe.observed_at BETWEEN episode.first_at AND episode.last_at
              ))
          )
      )
      AND result.value->'schemaVersion'='2'::jsonb
      AND result.value->'counts'->'attempted'='0'::jsonb
      AND jsonb_array_length(result.value->'operationIds')=1
      AND jsonb_array_length(result.value->'verificationIds')=1 AS quiet
    FROM specialist_delivery_receipts delivery JOIN specialist_assignments assignment ON assignment.id=delivery.assignment_id
    JOIN specialist_input_revisions input ON input.assignment_id=assignment.id AND input.revision=delivery.input_revision
    JOIN run_results result ON result.run_id=delivery.run_id AND result.revision=delivery.result_revision
    WHERE delivery.id=${deliveryId}
  `)
  ).rows;

  return row?.quiet === true;
}

/** Resolve the frozen recipient under current account, owner and complete source authority. */
export async function authorizePendingAssignmentDelivery(
  tx: SqlTransaction,
  deliveryId: string,
): Promise<AuthorizedAssignmentDelivery> {
  await beginAssignmentTransaction(tx);
  const [row] = (
    await tx.execute(sql`
    SELECT receipt.snapshot,head.status,head.input_revision,head.project_task_id,input.authority_snapshot->'executionPolicy' AS policy
    FROM specialist_delivery_receipts receipt
    JOIN specialist_assignments head ON head.id=receipt.assignment_id
    JOIN specialist_input_revisions input ON input.assignment_id=receipt.assignment_id AND input.revision=receipt.input_revision
    WHERE receipt.id=${deliveryId} FOR SHARE OF receipt,head,input
  `)
  ).rows;

  if (!row)
    throw new MaisterError(
      "PRECONDITION",
      "Assignment delivery is unavailable",
      { details: { reason: "assignment_delivery_unavailable" } },
    );
  const snapshot = assignmentResultWitnessSchema.parse(row.snapshot);
  const policy = executionPolicySchema.parse(row.policy);

  await authorizeAssignment(
    tx,
    snapshot.requesterUserId,
    snapshot.owner,
    "assignments:read",
    policy,
  );
  await authorizeSourceRestrictions(
    tx,
    { kind: "user", userId: snapshot.requesterUserId },
    snapshot.sourceRestrictions,
  );
  await validateAssignmentDestination(
    tx,
    snapshot.requesterUserId,
    snapshot.owner,
    snapshot.destination,
  );
  if (
    row.status === "cancelled" ||
    row.status === "failed" ||
    row.input_revision !== snapshot.inputRevision
  )
    throw new MaisterError(
      "PRECONDITION",
      "The retained result no longer names current requested work",
      { details: { reason: "assignment_delivery_superseded" } },
    );
  const ready = await tx.execute(sql`
    SELECT execution.id FROM runs execution JOIN run_results result ON result.run_id=execution.id
    WHERE execution.id=${snapshot.runId} AND execution.status IN ('Done','Review')
      AND result.revision=${snapshot.resultRevision} AND result.validity='valid'
      AND result.schema_ref=${snapshot.schemaRef} AND result.schema_sha256=${snapshot.schemaSha256}
      AND result.schema_version=${snapshot.resultSchemaVersion}
      AND encode(sha256(convert_to(jsonb_build_object('schemaRef',result.schema_ref,'schemaVersion',result.schema_version,'schemaSha256',result.schema_sha256,'value',result.value)::text,'UTF8')),'hex')=${snapshot.resultSha256}
    FOR SHARE OF execution,result
  `);

  if (ready.rows.length !== 1)
    throw new MaisterError(
      "PRECONDITION",
      "The exact result is unavailable or no longer current",
      { details: { reason: "assignment_delivery_result_unavailable" } },
    );

  return {
    id: deliveryId,
    snapshot,
    projectTaskId: z.string().nullable().parse(row.project_task_id),
  };
}

/** Internal effects and transport acknowledgement share the caller's transaction. */
export async function applyInternalAssignmentDelivery(
  tx: SqlTransaction,
  delivery: AuthorizedAssignmentDelivery,
): Promise<void> {
  const { snapshot } = delivery;

  if (snapshot.destination.kind === "inbox") {
    await tx.execute(sql`
      INSERT INTO inbox_items(id,recipient_type,recipient_id,company_id,project_id,task_id,assignment_delivery_id,event_kind,source_ref)
      VALUES(${delivery.id},'user',${snapshot.requesterUserId},${snapshot.owner.kind === "company" ? snapshot.owner.companyId : null},${snapshot.owner.kind === "project" ? snapshot.owner.projectId : null},${delivery.projectTaskId},${delivery.id},'assignment_result_available',${JSON.stringify({ kind: "assignment_delivery", assignmentId: snapshot.assignmentId, deliveryId: delivery.id, runId: snapshot.runId, resultRevision: snapshot.resultRevision })}::jsonb)
      ON CONFLICT(assignment_delivery_id) DO NOTHING
    `);

    return;
  }
  if (snapshot.destination.kind !== "task_comment")
    throw new MaisterError(
      "CONFIG",
      "An outbound reply requires the existing HTTP sender",
    );
  const roles = projectRolesForActions(["commentTask"]);
  const authority = await tx.execute(sql`
    SELECT id FROM users WHERE id=${snapshot.requesterUserId} AND (role='admin' OR EXISTS(
      SELECT 1 FROM project_members membership WHERE membership.project_id=${snapshot.destination.projectId}
        AND membership.user_id=${snapshot.requesterUserId} AND membership.role IN (${sql.join(
          roles.map((role) => sql`${role}`),
          sql`, `,
        )})
    ))
  `);

  if (authority.rows.length !== 1)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current task comment authority is required",
      { details: { reason: "assignment_destination_unavailable" } },
    );
  const prior = await tx.execute(
    sql`SELECT id FROM task_comments WHERE via_operation_id=${delivery.id}`,
  );

  if (prior.rows.length) return;
  await addTaskComment(
    {
      taskId: snapshot.destination.taskId,
      body: `Result available / Результат доступен: [Run / Запуск](/runs/${snapshot.runId}).`,
      actor: { type: "system", id: null },
      producedByRunId: snapshot.runId,
      viaOperationId: delivery.id,
    },
    tx,
  );
}
