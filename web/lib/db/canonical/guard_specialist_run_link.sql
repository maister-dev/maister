CREATE OR REPLACE FUNCTION public.guard_specialist_run_link()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Assignment execution links are immutable; retain the existing run and input identity'
    USING ERRCODE='23514', CONSTRAINT='specialist_run_links_immutable';
END;
$function$;
