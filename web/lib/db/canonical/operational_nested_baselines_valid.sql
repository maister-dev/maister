CREATE OR REPLACE FUNCTION public.operational_nested_baselines_valid(mounts jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN jsonb_typeof(mounts) = 'array' THEN NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(mounts) AS mounts(mount)
    WHERE mount->'baseline'->'version' = '2'::jsonb
      AND NOT public.operational_ephemeral_baseline_v2_valid(mount->'baseline')
  ) ELSE true END
$function$;
