CREATE OR REPLACE FUNCTION public.guard_specialist_root_recovery()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  CASE inspect_specialist_root_recovery(OLD.id)
    WHEN 'allowed' THEN RETURN NEW;
    WHEN 'busy' THEN RAISE EXCEPTION 'Assignment admission or review holds the current appointment'
      USING ERRCODE='55P03';
    ELSE RAISE EXCEPTION 'The retained Run is not eligible to recover the current assignment'
      USING ERRCODE='23514',CONSTRAINT='specialist_assignment_root_recovery_conflict';
  END CASE;
END $function$;
