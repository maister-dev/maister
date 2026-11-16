CREATE OR REPLACE FUNCTION public.task_launch_canonical_admission(value jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE STRICT
AS $function$
DECLARE result text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{'||coalesce(string_agg(to_jsonb(entry.key)::text||':'||task_launch_canonical_admission(entry.value),',' ORDER BY entry.key COLLATE "C"),'')||'}'
        INTO result FROM jsonb_each(value) entry;
    WHEN 'array' THEN
      SELECT '['||coalesce(string_agg(task_launch_canonical_admission(entry.value),',' ORDER BY entry.ordinality),'')||']'
        INTO result FROM jsonb_array_elements(value) WITH ORDINALITY entry(value,ordinality);
    ELSE RETURN value::text;
  END CASE;
  RETURN result;
END $function$;
