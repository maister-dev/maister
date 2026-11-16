import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";

import { sql } from "drizzle-orm";

type OperationalEvidence = Readonly<{
  outcome: string;
  operationIds: readonly string[];
  verificationIds: readonly string[];
}>;
type InvalidEvidencePath = "operationIds" | "verificationIds";

/** Match every supplied evidence ID to the Run's exact frozen assignment input and appointed targets. */
export async function invalidStandResultEvidence(
  tx: SqlTransaction,
  runId: string,
  value: OperationalEvidence,
): Promise<InvalidEvidencePath | null> {
  const operationIds = JSON.stringify(value.operationIds);
  const verificationIds = JSON.stringify(value.verificationIds);
  const success = value.outcome === "success";
  const [result] = (
    await tx.execute(sql`
    WITH input AS (
      SELECT link.assignment_id, captured.revision, captured.digest, trigger.stand_inspection,
        coalesce(work.definition->'objectiveInput', captured.objective_input) AS objective
      FROM specialist_run_links link
      JOIN specialist_assignments business ON business.id=link.assignment_id
      LEFT JOIN agent_trigger_attempts trigger ON trigger.id=business.origin->>'triggerAttemptId'
        AND trigger.schedule_id=business.origin->>'scheduleId' AND business.origin->>'kind'='schedule'
      JOIN LATERAL (
        SELECT revision,digest,objective_input FROM specialist_input_revisions candidate
        WHERE candidate.assignment_id=link.assignment_id
          AND specialist_run_has_input(link.run_id,link.assignment_id,candidate.revision,candidate.digest)
        ORDER BY candidate.revision DESC LIMIT 1
      ) captured ON true
      LEFT JOIN specialist_work work ON work.id=link.work_id AND work.work_revision=link.work_revision
      WHERE link.run_id=${runId}
    ), operations AS (
      SELECT operation.id,operation.target_id,operation.effect_state,operation.action
      FROM stand_operations operation JOIN input ON input.assignment_id=operation.assignment_id
        AND input.revision=operation.input_revision AND input.digest=operation.input_sha256
        AND (input.objective->'targetIds') ? operation.target_id
      WHERE operation.id IN (SELECT jsonb_array_elements_text(${operationIds}::jsonb))
        AND ((operation.action='restart'
          AND EXISTS (SELECT 1 FROM stand_operation_receipts receipt WHERE receipt.operation_id=operation.id)
          AND (NOT ${success} OR operation.effect_state='confirmed_applied'))
          OR (operation.action='inspect' AND operation.effect_state='not_dispatched'
            AND (input.stand_inspection IS NULL OR (
              operation.target_id=input.stand_inspection->>'targetId'
              AND operation.component_id=input.stand_inspection->>'componentId'
              AND to_jsonb(operation.config_revision)=input.stand_inspection->'configRevision'
              AND operation.target_incarnation=input.stand_inspection->>'incarnationId'
            ))
            AND EXISTS (SELECT 1 FROM stand_verifications probe WHERE probe.operation_id=operation.id AND probe.effect_receipt_id IS NULL)))
    ), verifications AS (
      SELECT probe.id,operation.id AS operation_id,operation.target_id,operation.action,probe.state
      FROM stand_verifications probe JOIN operations operation ON operation.id=probe.operation_id
      WHERE probe.id IN (SELECT jsonb_array_elements_text(${verificationIds}::jsonb))
        AND (NOT ${success} OR (probe.state='healthy' AND NOT EXISTS (
          SELECT 1 FROM stand_verifications newer WHERE newer.operation_id=probe.operation_id
            AND newer.target_sequence>probe.target_sequence
        )))
    ), requirements AS (
      SELECT requirement->>'kind' AS kind,requirement->>'referenceId' AS reference_id
      FROM input CROSS JOIN LATERAL jsonb_array_elements(input.objective->'verification') requirement
      WHERE ${success} AND requirement->'required'='true'::jsonb
    )
    SELECT (SELECT count(*) FROM operations)::integer AS operations,
      (SELECT count(*) FROM verifications)::integer AS verifications,
      EXISTS(SELECT 1 FROM requirements WHERE kind='effect' AND NOT EXISTS (
        SELECT 1 FROM operations WHERE effect_state='confirmed_applied'
          AND (reference_id IS NULL OR reference_id IN (id,target_id))
      )) AS missing_effect,
      EXISTS(SELECT 1 FROM requirements WHERE kind='health' AND NOT EXISTS (
        SELECT 1 FROM verifications WHERE state='healthy'
          AND (reference_id IS NULL OR reference_id IN (id,operation_id,target_id))
      )) OR (${success} AND EXISTS(SELECT 1 FROM input WHERE stand_inspection IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM verifications WHERE action='inspect' AND state='healthy')) AS missing_health
  `)
  ).rows;

  if (
    result?.operations !== value.operationIds.length ||
    result.missing_effect === true
  )
    return "operationIds";
  if (
    result.verifications !== value.verificationIds.length ||
    result.missing_health === true
  )
    return "verificationIds";

  return null;
}
