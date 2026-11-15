CREATE OR REPLACE FUNCTION public.brain_check_source_owner()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE source_project text; source_company text;
BEGIN
  IF NEW.source_id IS NULL THEN RETURN NEW; END IF;
  SELECT project_id,company_id INTO source_project,source_company FROM brain_sources WHERE id=NEW.source_id;
  IF NOT FOUND THEN RETURN NEW; END IF; -- The existing source FK reports missing sources.
  IF TG_TABLE_NAME='brain_index_jobs' THEN
    IF source_project IS DISTINCT FROM NEW.project_id OR source_company IS NOT NULL THEN
      RAISE EXCEPTION 'Repository indexing requires a matching project source' USING ERRCODE='23514', CONSTRAINT='brain_source_owner_check';
    END IF;
  ELSIF source_project IS DISTINCT FROM NEW.project_id OR source_company IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'Chunk and source ownership must match' USING ERRCODE='23514', CONSTRAINT='brain_source_owner_check';
  END IF;
  RETURN NEW;
END $function$;
