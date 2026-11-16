CREATE OR REPLACE FUNCTION public.guard_task_launch_preparation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE phases text[]:=ARRAY['reserved','checkout_ready','materializing','materialized','run_bound'];
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.reservation_lane='concurrent' AND NOT (
      NEW.principal_kind='session_user' AND NEW.basis->>'kind'='manual'
      OR NEW.principal_kind='system' AND NEW.basis->>'kind'='automatic'
        AND NEW.settings_snapshot->'serverExecution'->>'kind'='evaluation'
        AND NEW.settings_snapshot->'serverExecution'->>'projectId'=NEW.project_id
        AND NEW.settings_snapshot->'serverExecution'->>'taskId'=NEW.task_id
        AND NEW.settings_snapshot->'serverExecution'->'execution'->>'evaluationBatchItemId'=NEW.settings_snapshot->'serverExecution'->>'id'
        AND EXISTS(SELECT 1 FROM evaluation_launch_batch_items item
          JOIN evaluation_launch_batches batch ON batch.id=item.batch_id
          JOIN evaluation_studies study ON study.id=batch.study_id
          WHERE item.id=NEW.settings_snapshot->'serverExecution'->>'id' AND item.status='launching'
            AND study.id=NEW.settings_snapshot->'serverExecution'->'execution'->>'evaluationStudyId'
            AND study.project_id=NEW.project_id AND study.task_id=NEW.task_id)
    ) IS TRUE THEN
      RAISE EXCEPTION 'Concurrent delivery requires its interactive decision or current controlled evaluation source'
        USING ERRCODE='23514',CONSTRAINT='task_launch_concurrent_authority';
    END IF;
    IF NEW.preparation_identity IS NOT NULL OR NEW.preparation_phase IS NOT NULL OR NEW.cleanup_state IS NOT NULL THEN
      RAISE EXCEPTION 'A new launch cannot fabricate preparation progress'
        USING ERRCODE='23514',CONSTRAINT='task_launch_preparation_initial';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.preparation_identity IS NOT NULL AND OLD.preparation_identity IS DISTINCT FROM NEW.preparation_identity THEN
    RAISE EXCEPTION 'Launch preparation identity is immutable'
      USING ERRCODE='23514',CONSTRAINT='task_launch_preparation_immutable';
  END IF;
  IF OLD.preparation_identity IS NULL AND NEW.preparation_identity IS NOT NULL THEN
    IF NEW.state<>'preparing' OR NEW.run_id IS NOT NULL OR NEW.preparation_phase<>'reserved'
      OR NEW.lease_expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'Preparation allocation requires a current unbound worker claim'
        USING ERRCODE='23514',CONSTRAINT='task_launch_preparation_owner';
    END IF;
  ELSIF OLD.preparation_phase IS DISTINCT FROM NEW.preparation_phase THEN
    IF OLD.state<>'preparing' OR OLD.lease_expires_at<=clock_timestamp()
      OR OLD.lease_token IS DISTINCT FROM NEW.lease_token AND NEW.state='preparing'
      OR (array_position(phases,NEW.preparation_phase)<>array_position(phases,OLD.preparation_phase)+1
        AND NOT (NEW.preparation_identity->'version'='2'::jsonb AND NEW.preparation_identity->>'kind'='agent' AND OLD.preparation_phase='reserved' AND NEW.preparation_phase='run_bound'))
      OR NEW.preparation_phase='run_bound' AND (NEW.state<>'run_bound' OR NEW.run_id IS DISTINCT FROM NEW.preparation_identity->>'runId') THEN
      RAISE EXCEPTION 'Preparation publication requires its current owner and next phase'
        USING ERRCODE='23514',CONSTRAINT='task_launch_preparation_owner';
    END IF;
  END IF;
  IF OLD.cleanup_state='removed' AND NEW.cleanup_state IS DISTINCT FROM OLD.cleanup_state
    OR OLD.cleanup_state IN ('pending','retained') AND NEW.cleanup_state IS NULL
    OR NEW.cleanup_state IS NOT NULL AND NEW.state NOT IN ('held','failed','cancelled','settled') THEN
    RAISE EXCEPTION 'Launch cleanup requires closed execution authority and cannot discard ownership or undo removal'
      USING ERRCODE='23514',CONSTRAINT='task_launch_preparation_cleanup';
  END IF;
  RETURN NEW;
END $function$;
