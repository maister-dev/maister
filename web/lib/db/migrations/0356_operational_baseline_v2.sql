CREATE FUNCTION public.operational_ephemeral_baseline_v2_valid(witness jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE
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
--> statement-breakpoint
CREATE FUNCTION public.operational_nested_baselines_valid(mounts jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $function$
  SELECT CASE WHEN jsonb_typeof(mounts) = 'array' THEN NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(mounts) AS mounts(mount)
    WHERE mount->'baseline'->'version' = '2'::jsonb
      AND NOT public.operational_ephemeral_baseline_v2_valid(mount->'baseline')
  ) ELSE true END
$function$;
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_operational_baseline_check";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_operational_baseline_check" CHECK ("runs"."operational_integrity_baseline" IS NULL OR (("runs"."agent_kind" = 'operational' OR ("runs"."run_kind"='agent' AND "runs"."agent_kind"='code_delivery' AND "runs"."task_launch_intent_id" IS NOT NULL) OR ("runs"."run_kind"='flow' AND "runs"."company_id" IS NOT NULL AND "runs"."project_id" IS NULL AND "runs"."agent_kind" IS NULL AND "runs"."agent_workspace"='none' AND "runs"."company_execution_snapshot"->>'schemaVersion'='2' AND "runs"."result_contract"->>'kind'='flow_export' AND "runs"."result_contract"->'required'='true'::jsonb)) AND jsonb_typeof("runs"."operational_integrity_baseline") = 'object' AND (
        ("runs"."operational_integrity_baseline"->'version' = '1'::jsonb AND
          ("runs"."agent_kind" = 'operational' OR NOT jsonb_path_exists("runs"."operational_integrity_baseline", '$.contextMounts[*].baseline ? (@.version == 2)')))
        OR ("runs"."agent_kind" = 'operational' AND operational_ephemeral_baseline_v2_valid("runs"."operational_integrity_baseline"))
      )
      AND NOT jsonb_path_exists("runs"."operational_integrity_baseline", '$.contextMounts[*].baseline ? (@.version != 1 && @.version != 2)')
      AND operational_nested_baselines_valid("runs"."operational_integrity_baseline"->'contextMounts') AND jsonb_typeof("runs"."operational_integrity_baseline"->'generation') = 'number' AND jsonb_typeof("runs"."operational_integrity_baseline"->'source') = 'array' AND jsonb_typeof("runs"."operational_integrity_baseline"->'platform') = 'array' AND pg_column_size("runs"."operational_integrity_baseline") <= 16777216) IS TRUE);
