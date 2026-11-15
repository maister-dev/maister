CREATE OR REPLACE FUNCTION public.guard_stand_recovery_disposition()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (
    OLD.disposition='authorized_successor'
    OR (NEW.disposition IN ('unresolved_hold','authorized_successor') AND NOT EXISTS (
      SELECT 1 FROM stand_recovery_decisions decision
      WHERE decision.operation_id=NEW.id AND decision.operation_revision=NEW.revision
        AND decision.decision=CASE NEW.disposition WHEN 'unresolved_hold' THEN 'hold' ELSE 'authorize_successor' END
    ))
  ) THEN
    RAISE EXCEPTION 'A stand recovery disposition requires its exact retained decision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
