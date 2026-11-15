CREATE OR REPLACE FUNCTION public.guard_stand_component_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM stand_target_revisions revision
    WHERE revision.target_id=NEW.target_id AND revision.revision=NEW.config_revision
      AND revision.component_ids ? NEW.component_id
  ) THEN
    RAISE EXCEPTION 'Stand components must be retained with their original configuration revision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
