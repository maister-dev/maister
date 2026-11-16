CREATE OR REPLACE FUNCTION public.guard_specialist_input_history()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Specialist input snapshots are immutable; append a new input revision'
    USING ERRCODE='23514', CONSTRAINT='specialist_input_revisions_immutable';
END;
$function$;
