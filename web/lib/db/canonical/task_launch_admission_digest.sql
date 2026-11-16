CREATE OR REPLACE FUNCTION public.task_launch_admission_digest(value jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE STRICT
AS $function$
  SELECT encode(sha256(convert_to(task_launch_canonical_admission(value),'UTF8')),'hex')
$function$;
