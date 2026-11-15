CREATE OR REPLACE FUNCTION public.brain_reject_history_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (
    SELECT 1 FROM brain_items i WHERE i.id=OLD.record_id
      AND (i.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=i.project_id))
  ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Knowledge history is immutable; create a new attributed revision' USING ERRCODE='23514', CONSTRAINT='brain_record_revision_immutable';
END $function$;
