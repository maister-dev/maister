ALTER TABLE "scratch_capability_profiles" ALTER COLUMN "materialized_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_commands" DROP CONSTRAINT "execution_commands_kind_check";--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_kind_check" CHECK ("execution_commands"."kind" in ('workspace.adopt', 'workspace.prepare', 'workspace.release', 'workspace.observe_head', 'workspace.publication', 'session.create', 'session.prompt', 'session.input', 'session.steer', 'session.cancel', 'session.checkpoint', 'session.delete', 'runtime_object.reserve', 'runtime_object.upload', 'runtime_object.delete', 'stand.dispatch'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_task_launch_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
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
        AND NOT (NEW.preparation_identity->'version'='2'::jsonb AND NEW.preparation_identity->>'kind'='agent' AND OLD.preparation_phase='reserved' AND NEW.preparation_phase='run_bound')
        AND NOT (
          OLD.preparation_phase='reserved' AND NEW.preparation_phase='run_bound'
          AND EXISTS (
            SELECT 1
            FROM workspaces workspace
            JOIN execution_commands command ON command.target_session_id = workspace.id
              AND command.run_id = workspace.run_id
              AND command.execution_host_id = workspace.execution_host_id
              AND command.execution_assignment_id = workspace.preparation_assignment_id
            WHERE workspace.run_id = NEW.run_id
              AND workspace.project_id = NEW.project_id
              AND workspace.ownership_kind = 'host_owned'
              AND workspace.execution_workspace_id IS NULL
              AND workspace.workspace_input_digest = NEW.input_digest
              AND workspace.base_commit = NEW.preparation_identity->>'baseCommit'
              AND command.kind = 'workspace.prepare'
              AND command.state = 'queued'
          )
        ))
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
END $$;

--> statement-breakpoint
CREATE FUNCTION guard_stage_c_workspace_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.kind = 'workspace.prepare' AND
    ROW(OLD.id, OLD.kind, OLD.created_at, OLD.run_id, OLD.execution_host_id, OLD.execution_assignment_id,
      OLD.assignment_epoch, OLD.target_session_id, OLD.payload) IS DISTINCT FROM
    ROW(NEW.id, NEW.kind, NEW.created_at, NEW.run_id, NEW.execution_host_id, NEW.execution_assignment_id,
      NEW.assignment_epoch, NEW.target_session_id, NEW.payload) THEN
    RAISE EXCEPTION 'Workspace preparation command inputs are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_prepare_command_immutable';
  END IF;
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.kind = 'workspace.prepare' AND NOT EXISTS (
    SELECT 1 FROM workspaces workspace
    JOIN runs run ON run.id = workspace.run_id
    JOIN execution_assignments assignment ON assignment.id = workspace.preparation_assignment_id
    WHERE workspace.id = NEW.target_session_id
      AND workspace.run_id = NEW.run_id
      AND run.status = 'Pending'
      AND run.execution_assignment_id = assignment.id
      AND assignment.id = NEW.execution_assignment_id
      AND assignment.epoch = NEW.assignment_epoch
      AND assignment.state = 'active'
      AND workspace.execution_host_id = NEW.execution_host_id
      AND workspace.ownership_kind = 'host_owned'
      AND workspace.execution_workspace_id IS NULL
      AND workspace.workspace_input_digest = NEW.payload->>'inputDigest'
      AND workspace.removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Workspace preparation requires its pending Run and exact assignment'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_prepare_owner_required';
  END IF;
  IF NEW.kind IN ('session.create', 'session.prompt') AND EXISTS (
    SELECT 1 FROM workspaces workspace
    WHERE workspace.run_id = NEW.run_id AND workspace.ownership_kind = 'host_owned'
      AND workspace.execution_workspace_id IS NULL AND workspace.removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Session dispatch requires the prepared workspace'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_preparation_pending';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER execution_commands_workspace_prepare_guard
BEFORE INSERT OR UPDATE ON execution_commands
FOR EACH ROW EXECUTE FUNCTION guard_stage_c_workspace_command();
