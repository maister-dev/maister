CREATE OR REPLACE FUNCTION public.guard_referenced_flow_revision_manifest()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (NEW.manifest,NEW.manifest_digest) IS DISTINCT FROM (OLD.manifest,OLD.manifest_digest)
    AND (EXISTS(SELECT 1 FROM runs WHERE flow_revision_id=OLD.id)
      OR EXISTS(SELECT 1 FROM task_launch_intents WHERE settings_snapshot->>'flowRevisionId'=OLD.id)) THEN
    RAISE EXCEPTION 'Referenced Flow revision manifest is immutable; publish a new revision'
      USING ERRCODE='23514',CONSTRAINT='flow_revisions_referenced_manifest_immutable';
  END IF;
  RETURN NEW;
END $function$;
