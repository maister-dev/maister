CREATE OR REPLACE FUNCTION public.guard_stand_permit_observation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;
