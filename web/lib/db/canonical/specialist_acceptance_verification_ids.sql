CREATE OR REPLACE FUNCTION public.specialist_acceptance_verification_ids(result_value jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN result_value->'schemaVersion'='2'::jsonb
    AND jsonb_typeof(result_value->'verificationIds')='array'
    THEN result_value->'verificationIds' ELSE '[]'::jsonb END
$function$;
