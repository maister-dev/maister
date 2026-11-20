CREATE OR REPLACE FUNCTION public.operational_ephemeral_baseline_v2_valid(witness jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT (
    jsonb_typeof(witness) = 'object'
    AND witness->'version' = '2'::jsonb
    AND witness->>'resourceKind' = 'ephemeral_checkout'
    AND witness->>'generation' ~ '^[0-9]{1,9}$'
    AND jsonb_typeof(witness->'generation') = 'number'
    AND jsonb_typeof(witness->'source') = 'array'
    AND jsonb_typeof(witness->'platform') = 'array'
    AND witness->>'head' ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'
    AND witness->'branch' IN ('null'::jsonb, '"HEAD"'::jsonb)
    AND witness->>'indexDigest' ~ '^[a-f0-9]{64}$'
    AND witness->>'indexContentDigest' ~ '^[a-f0-9]{64}$'
    AND witness->>'historyDigest' ~ '^[a-f0-9]{64}$'
    AND witness->>'gitIdentity' ~ '^[a-f0-9]{64}$'
    AND witness->>'gitConfigDigest' ~ '^[a-f0-9]{64}$'
    AND (witness->'worktreeConfigDigest' = 'null'::jsonb
      OR witness->>'worktreeConfigDigest' ~ '^[a-f0-9]{64}$')
    AND CASE WHEN jsonb_typeof(witness->'refs') = 'array' THEN (
      SELECT count(*) = count(DISTINCT ref->>'ref')
        AND coalesce(bool_and((jsonb_typeof(ref) = 'object'
          AND ref->>'ref' LIKE 'refs/%'
          AND ref->>'sha' ~ '^([a-f0-9]{40}|[a-f0-9]{64})$') IS TRUE), true)
      FROM jsonb_array_elements(witness->'refs') AS refs(ref)
    ) ELSE false END
  ) IS TRUE
$function$;
