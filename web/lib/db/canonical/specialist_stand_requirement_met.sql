CREATE OR REPLACE FUNCTION public.specialist_stand_requirement_met(subject_id text, selected_input integer, selected_digest text, objective jsonb, result_value jsonb, requirement_kind text, reference_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT result_value->>'outcome'='success' AND EXISTS (
    SELECT 1 FROM stand_operations operation
    LEFT JOIN stand_operation_receipts effect ON effect.operation_id=operation.id
      AND effect.receipt->>'effectState'='confirmed_applied'
    WHERE operation.assignment_id=subject_id AND operation.input_revision=selected_input
      AND operation.input_sha256=selected_digest
      AND ((operation.action='restart' AND operation.effect_state='confirmed_applied' AND effect.id IS NOT NULL)
        OR (requirement_kind='health' AND operation.action='inspect' AND operation.effect_state='not_dispatched'))
      AND (objective->'targetIds') ? operation.target_id
      AND jsonb_typeof(result_value->'operationIds')='array'
      AND (result_value->'operationIds') ? operation.id
      AND (
        (requirement_kind='effect' AND (reference_id IS NULL OR reference_id IN (operation.id,operation.target_id)))
        OR (requirement_kind='health' AND EXISTS (
          SELECT 1 FROM stand_verifications probe WHERE probe.effect_receipt_id IS NOT DISTINCT FROM effect.id
            AND probe.operation_id=operation.id AND probe.state='healthy'
            AND jsonb_typeof(result_value->'verificationIds')='array'
            AND (result_value->'verificationIds') ? probe.id
            AND (reference_id IS NULL OR reference_id IN (probe.id,operation.id,operation.target_id))
            AND NOT EXISTS (SELECT 1 FROM stand_verifications newer
              WHERE newer.operation_id=probe.operation_id AND newer.target_sequence>probe.target_sequence)
        ))
      )
  )
$function$;
