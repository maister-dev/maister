CREATE OR REPLACE FUNCTION public.maister_guard_execution_host_loss()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'permanent execution host loss evidence is immutable' USING ERRCODE = '23514';
END;
$function$;
