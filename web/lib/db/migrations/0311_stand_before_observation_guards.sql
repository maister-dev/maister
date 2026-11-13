-- Custom SQL migration file, put your code below! --
CREATE FUNCTION guard_stand_before_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  effect text;
  action text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'A stand observation is immutable' USING ERRCODE='23514';
  END IF;
  SELECT operation.effect_state,operation.action INTO effect,action
    FROM stand_operations operation WHERE operation.id=NEW.operation_id FOR SHARE;
  IF FOUND AND (action<>'restart' OR effect<>'not_dispatched') THEN
    RAISE EXCEPTION 'A before-effect observation requires a pending restart' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stand_before_observation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON stand_operation_observations
  FOR EACH ROW EXECUTE FUNCTION guard_stand_before_observation();
--> statement-breakpoint
CREATE FUNCTION guard_stand_permit_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.purpose='dispatch' AND NOT EXISTS (
    SELECT 1 FROM stand_resource_claims claim
    JOIN execution_commands command ON command.id=claim.owner_id
    JOIN stand_operation_observations observation
      ON observation.id=command.payload->>'beforeObservationId'
      AND observation.operation_id=NEW.operation_id
    WHERE claim.operation_id=NEW.operation_id
      AND observation.observed_state<>'unknown'
  ) THEN
    RAISE EXCEPTION 'Stand authorization requires an exact retained before-effect observation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stand_permit_observation_guard BEFORE INSERT ON stand_authorization_permits
  FOR EACH ROW EXECUTE FUNCTION guard_stand_permit_observation();
