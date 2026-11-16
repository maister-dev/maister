CREATE OR REPLACE FUNCTION public.guard_stand_operation_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'A retained target receipt is immutable' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM stand_operations operation
    JOIN stand_resource_claims claim ON claim.operation_id=operation.id AND claim.unresolved
    JOIN execution_commands command ON command.id=claim.owner_id AND command.kind='stand.dispatch'
      AND command.payload->>'operationId'=operation.id
    JOIN stand_operation_observations observation ON observation.operation_id=operation.id
      AND observation.id=command.payload->>'beforeObservationId'
    WHERE operation.id=NEW.operation_id AND operation.action='restart'
      AND operation.effect_state IN ('dispatching','unknown')
      AND NEW.receipt->>'operationId'=operation.id
      AND NEW.receipt->>'targetIncarnation'=operation.target_incarnation
      AND NEW.receipt->>'requestDigest'=operation.request_digest
      AND NEW.receipt->>'receiptRevision'=NEW.target_receipt_revision::text
      AND NEW.receipt->>'sequence'=NEW.target_sequence::text
      AND NEW.receipt ? 'beforeInvocation' AND NEW.receipt ? 'permitId'
      AND NEW.receipt->>'beforeInvocation' IS NOT DISTINCT FROM observation.invocation_id
      AND NEW.receipt->>'permitId' IS NOT DISTINCT FROM NEW.permit_id
      AND NEW.target_sequence>observation.target_sequence
      AND (
        (NEW.receipt->>'effectState'='confirmed_not_applied' AND NEW.permit_id IS NULL
          AND NEW.target_receipt_revision=2 AND NEW.receipt->>'reason' IN ('authority_refused','before_state_changed'))
        OR (NEW.receipt->>'effectState'='unknown' AND (
          (NEW.target_receipt_revision=2 AND NEW.permit_id IS NOT NULL)
          OR (NEW.target_receipt_revision=3 AND NEW.permit_id IS NOT NULL AND NEW.receipt->>'reason'='effect_unknown')
        ))
        OR (NEW.receipt->>'effectState'='confirmed_applied' AND NEW.permit_id IS NOT NULL
          AND NEW.target_receipt_revision=3 AND NEW.receipt->>'observedState'='active'
          AND NEW.receipt->>'afterInvocation' ~ '^[a-f0-9]{32}$'
          AND NEW.receipt->>'afterInvocation' IS DISTINCT FROM observation.invocation_id)
      )
      AND (NEW.permit_id IS NULL OR EXISTS (
        SELECT 1 FROM stand_authorization_permits permit
        WHERE permit.id=NEW.permit_id AND permit.operation_id=operation.id
          AND permit.purpose='dispatch' AND permit.owner_epoch=claim.owner_epoch
      ))
  ) THEN
    RAISE EXCEPTION 'A target receipt requires its exact dispatch, observation and permit' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
