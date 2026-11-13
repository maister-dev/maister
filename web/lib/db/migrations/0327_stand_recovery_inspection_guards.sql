CREATE OR REPLACE FUNCTION guard_stand_before_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  operation stand_operations%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'A stand observation is immutable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO operation FROM stand_operations WHERE id=NEW.operation_id FOR SHARE;
  IF NOT FOUND OR operation.action<>'restart' OR (
    NEW.recovery_revision IS NULL AND operation.effect_state<>'not_dispatched'
  ) OR (
    NEW.recovery_revision IS NOT NULL AND (
      operation.effect_state<>'unknown' OR operation.disposition='authorized_successor'
      OR NEW.recovery_revision<>operation.revision OR NOT EXISTS (
        SELECT 1 FROM stand_read_claims reader
        JOIN stand_authorization_permits permit
          ON permit.operation_id=reader.operation_id AND permit.purpose=reader.purpose
          AND permit.owner_epoch=reader.owner_epoch
        WHERE reader.operation_id=operation.id AND reader.purpose='reconcile'
          AND reader.owner_epoch=NEW.recovery_read_epoch AND reader.token_id IS NULL
          AND reader.expires_at>clock_timestamp()
      ) OR EXISTS (
        SELECT 1 FROM stand_operation_observations existing
        WHERE existing.operation_id=operation.id AND existing.target_sequence>=NEW.target_sequence
      )
    )
  ) THEN
    RAISE EXCEPTION 'A stand observation requires its exact pending restart or authorized recovery read' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
