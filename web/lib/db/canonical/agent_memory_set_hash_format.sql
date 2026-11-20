CREATE OR REPLACE FUNCTION public.agent_memory_set_hash_format()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.agent_memory_hash IS NULL THEN
    NEW.agent_memory_hash_format := NULL;
    RETURN NEW;
  END IF;
  IF NEW.agent_memory_hash_format IS NULL THEN
    IF EXISTS (SELECT 1 FROM agent_memory_cutover) THEN
      RAISE EXCEPTION 'Use the activated agent memory vault writer'
        USING ERRCODE = '23514', CONSTRAINT = 'agent_memory_run_writer_required';
    END IF;
    NEW.agent_memory_hash_format := 'legacy-file-v1';
  END IF;
  IF NEW.agent_memory_hash_format NOT IN ('legacy-file-v1', 'vault-manifest-v1') THEN
    RAISE EXCEPTION 'Agent memory hash format is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_memory_run_hash_format';
  END IF;
  RETURN NEW;
END;
$function$;
