CREATE OR REPLACE FUNCTION public.guard_specialist_context_owner_epoch()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  current_epoch integer;
BEGIN
  IF NEW.actor->>'kind'='agent' THEN
    current_epoch := specialist_execution_owner_epoch(NEW.actor->>'runId');
  END IF;
  IF current_epoch=-1 OR NEW.owner_epoch IS DISTINCT FROM current_epoch OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.context->'entries') item
      WHERE item->'introducedRevision'=to_jsonb(NEW.revision)
        AND item->'ownerEpoch' IS DISTINCT FROM COALESCE(to_jsonb(NEW.owner_epoch),'null'::jsonb)
  ) THEN
    RAISE EXCEPTION 'Context requires the current specialist executor lease'
      USING ERRCODE='23514',CONSTRAINT='specialist_context_owner_epoch_required';
  END IF;
  RETURN NEW;
END $function$;
