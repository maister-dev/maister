CREATE FUNCTION guard_stand_verification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'A stand verification is immutable' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM stand_operations operation
    JOIN stand_operation_receipts effect ON effect.operation_id=operation.id AND effect.id=NEW.effect_receipt_id
    JOIN stand_read_claims claim ON claim.operation_id=operation.id AND claim.purpose='verify'
    WHERE operation.id=NEW.operation_id AND operation.effect_state='confirmed_applied'
      AND effect.receipt->>'effectState'='confirmed_applied' AND NEW.target_sequence>effect.target_sequence
      AND NEW.issued_at>=date_trunc('milliseconds',effect.received_at) AND NEW.issued_at<=clock_timestamp()
      AND claim.owner_epoch=NEW.owner_epoch AND claim.actor_id=NEW.actor_id AND claim.expires_at>clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM stand_verifications previous
        WHERE previous.operation_id=operation.id AND previous.target_sequence>=NEW.target_sequence)
  ) THEN
    RAISE EXCEPTION 'A stand verification requires a current owner and a later probe than the applied effect' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stand_verification_guard BEFORE INSERT OR UPDATE OR DELETE ON stand_verifications
FOR EACH ROW EXECUTE FUNCTION guard_stand_verification();
--> statement-breakpoint
CREATE FUNCTION guard_stand_verification_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.effect_state<>'confirmed_applied' OR NOT EXISTS (
    SELECT 1 FROM (
      SELECT state FROM stand_verifications
      WHERE operation_id=NEW.id ORDER BY target_sequence DESC LIMIT 1
    ) latest WHERE latest.state=NEW.verification_state
  ) THEN
    RAISE EXCEPTION 'A stand verification projection requires its latest retained probe' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stand_verification_projection_guard BEFORE UPDATE ON stand_operations FOR EACH ROW
WHEN (OLD.verification_state IS DISTINCT FROM NEW.verification_state)
EXECUTE FUNCTION guard_stand_verification_projection();
