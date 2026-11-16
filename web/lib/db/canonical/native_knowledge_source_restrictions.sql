CREATE OR REPLACE FUNCTION public.native_knowledge_source_restrictions(source_values jsonb)
 RETURNS SETOF jsonb
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE STRICT COST 1 ROWS 4
AS $function$
BEGIN
  RETURN QUERY SELECT entry FROM jsonb_array_elements(source_values) entry;
END;
$function$;
