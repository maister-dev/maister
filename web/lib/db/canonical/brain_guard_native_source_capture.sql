CREATE OR REPLACE FUNCTION public.brain_guard_native_source_capture()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.chunker_id <> 'native_submission' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' AND OLD.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=OLD.project_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Submitted source captures are immutable; capture a new version or delete the owning project' USING ERRCODE='23514', CONSTRAINT='brain_native_capture_immutable';
END $function$;
