-- Small native restriction arrays have a low planner estimate; every entry is still returned.
CREATE FUNCTION native_knowledge_source_restrictions(source_values jsonb)
RETURNS SETOF jsonb
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE COST 1 ROWS 4
AS $$
BEGIN
  RETURN QUERY SELECT entry FROM jsonb_array_elements(source_values) entry;
END;
$$;
