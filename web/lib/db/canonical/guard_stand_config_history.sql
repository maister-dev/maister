CREATE OR REPLACE FUNCTION public.guard_stand_config_history()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Retained stand configuration is immutable' USING ERRCODE='23514';
END;
$function$;
