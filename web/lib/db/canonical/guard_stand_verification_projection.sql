CREATE OR REPLACE FUNCTION public.guard_stand_verification_projection()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT ((NEW.action='restart' AND NEW.effect_state='confirmed_applied') OR
    (NEW.action='inspect' AND NEW.effect_state='not_dispatched')) OR NOT EXISTS (
    SELECT 1 FROM (
      SELECT state FROM stand_verifications
      WHERE operation_id=NEW.id ORDER BY target_sequence DESC LIMIT 1
    ) latest WHERE latest.state=NEW.verification_state
  ) THEN
    RAISE EXCEPTION 'A stand verification projection requires its latest retained probe' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
