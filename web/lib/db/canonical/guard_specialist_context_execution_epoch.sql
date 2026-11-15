CREATE OR REPLACE FUNCTION public.guard_specialist_context_execution_epoch()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  source runs%ROWTYPE;
  current_epoch bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.context->'entries') item
    WHERE item->'introducedRevision'=to_jsonb(NEW.revision)
      AND item->'executionEpoch' IS DISTINCT FROM to_jsonb(NEW.execution_epoch)
  ) THEN
    RAISE EXCEPTION 'Context entries require the exact originating execution epoch'
      USING ERRCODE='23514',CONSTRAINT='specialist_context_execution_epoch_required';
  END IF;
  IF NEW.actor->>'kind'<>'agent' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO source FROM runs WHERE id=NEW.actor->>'runId' FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Execution-authored context requires its actual Run'
      USING ERRCODE='23514',CONSTRAINT='specialist_context_execution_epoch_required';
  END IF;
  IF source.execution_assignment_id IS NULL AND NEW.execution_epoch IS NULL AND NOT EXISTS (
    SELECT 1 FROM execution_assignments placement WHERE placement.run_id=source.id
  ) THEN
    RETURN NEW;
  END IF;
  SELECT placement.epoch INTO current_epoch FROM execution_assignments placement
    WHERE placement.id=source.execution_assignment_id AND placement.run_id=source.id
      AND placement.state='active' AND (placement.lease_expires_at IS NULL OR placement.lease_expires_at>clock_timestamp())
    FOR SHARE;
  IF NOT FOUND OR NEW.execution_epoch IS DISTINCT FROM current_epoch THEN
    RAISE EXCEPTION 'Context requires the exact current execution owner epoch'
      USING ERRCODE='23514',CONSTRAINT='specialist_context_execution_epoch_required';
  END IF;
  RETURN NEW;
END $function$;
