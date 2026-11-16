CREATE OR REPLACE FUNCTION public.guard_stand_verification()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'A stand verification is immutable' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM stand_operations operation
    LEFT JOIN stand_operation_receipts effect ON effect.operation_id=operation.id AND effect.id=NEW.effect_receipt_id
    JOIN stand_read_claims claim ON claim.operation_id=operation.id AND claim.purpose='verify'
    WHERE operation.id=NEW.operation_id AND NEW.issued_at<=clock_timestamp()
      AND (
        (operation.action='restart' AND operation.effect_state='confirmed_applied'
          AND effect.receipt->>'effectState'='confirmed_applied'
          AND NEW.target_sequence>effect.target_sequence
          AND NEW.issued_at>=date_trunc('milliseconds',effect.received_at))
        OR (operation.action='inspect' AND operation.effect_state='not_dispatched' AND NEW.effect_receipt_id IS NULL
          AND NEW.issued_at>=date_trunc('milliseconds',operation.created_at))
      )
      AND claim.owner_epoch=NEW.owner_epoch AND claim.actor_id=NEW.actor_id AND claim.expires_at>clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM stand_verifications previous
        WHERE previous.operation_id=operation.id AND previous.target_sequence>=NEW.target_sequence)
  ) THEN
    RAISE EXCEPTION 'A stand verification requires a current owner and a later probe than the applied effect' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
