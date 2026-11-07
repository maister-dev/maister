ALTER TABLE "task_launch_intents" ADD COLUMN "dispatch_receipt" jsonb;--> statement-breakpoint
CREATE FUNCTION guard_task_launch_dispatch_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.dispatch_receipt IS NOT NULL THEN
    RAISE EXCEPTION 'A new accepted launch has not dispatched'
      USING ERRCODE='23514',CONSTRAINT='task_launch_dispatch_receipt_initial';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.dispatch_receipt IS NOT NULL AND OLD.dispatch_receipt IS DISTINCT FROM NEW.dispatch_receipt THEN
      RAISE EXCEPTION 'First dispatch receipt is immutable across continuation epochs'
        USING ERRCODE='23514',CONSTRAINT='task_launch_dispatch_receipt_immutable';
    END IF;
    IF OLD.dispatch_receipt IS NULL AND NEW.dispatch_receipt IS NOT NULL THEN
      IF OLD.dispatch_committed_at IS NOT NULL OR OLD.state<>'run_bound' OR NEW.state<>'run_bound'
        OR NOT (
          jsonb_typeof(NEW.dispatch_receipt)='object' AND NEW.dispatch_receipt->'version'='1'::jsonb
          AND NEW.dispatch_receipt->>'runId'=NEW.run_id
          AND NEW.dispatch_receipt->>'inputDigest'=NEW.input_digest
          AND NEW.dispatch_receipt->>'settingsDigest'=NEW.settings_digest
          AND (NEW.dispatch_receipt->>'committedAt')::timestamptz=NEW.dispatch_committed_at
          AND NEW.dispatch_receipt-ARRAY['version','runId','assignmentId','assignmentEpoch','inputDigest','settingsDigest','committedAt']='{}'::jsonb
          AND octet_length(NEW.dispatch_receipt::text)<=8192
          AND EXISTS(SELECT 1 FROM execution_assignments assignment
            WHERE assignment.id=NEW.dispatch_receipt->>'assignmentId' AND assignment.run_id=NEW.run_id
              AND assignment.state='active' AND to_jsonb(assignment.epoch)=NEW.dispatch_receipt->'assignmentEpoch')
        ) IS TRUE THEN
        RAISE EXCEPTION 'First dispatch must bind its current run assignment and exact accepted request'
          USING ERRCODE='23514',CONSTRAINT='task_launch_dispatch_receipt_owner';
      END IF;
    END IF;
    IF OLD.dispatch_committed_at IS NULL AND NEW.dispatch_committed_at IS NOT NULL AND NEW.dispatch_receipt IS NULL THEN
      RAISE EXCEPTION 'A timestamp alone cannot establish execution commitment'
        USING ERRCODE='23514',CONSTRAINT='task_launch_dispatch_receipt_required';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_launch_dispatch_receipt_guard BEFORE INSERT OR UPDATE ON task_launch_intents
  FOR EACH ROW EXECUTE FUNCTION guard_task_launch_dispatch_receipt();
--> statement-breakpoint
CREATE FUNCTION settle_task_launch_for_terminal_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_run runs%ROWTYPE; intent task_launch_intents%ROWTYPE;
BEGIN
  SELECT * INTO current_run FROM runs WHERE id=NEW.id;
  IF NOT FOUND OR current_run.task_launch_intent_id IS NULL OR current_run.status NOT IN ('Done','Failed','Crashed','Abandoned') THEN RETURN NULL; END IF;
  SELECT * INTO intent FROM task_launch_intents WHERE id=current_run.task_launch_intent_id FOR UPDATE;
  IF NOT FOUND OR intent.state IN ('settled','cancelled','failed') THEN RETURN NULL; END IF;
  IF intent.run_id IS DISTINCT FROM current_run.id OR intent.state NOT IN ('run_bound','held','queued','preparing') THEN
    RAISE EXCEPTION 'Terminal execution must settle its own bound launch'
      USING ERRCODE='23514',CONSTRAINT='task_launch_terminal_owner';
  END IF;
  UPDATE task_launch_intents SET state='settled',terminal_outcome=current_run.status,
    state_version=state_version+1,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE id=intent.id RETURNING * INTO intent;
  INSERT INTO domain_events(project_id,task_id,run_id,kind,actor_type,actor_id,payload,occurred_at)
    VALUES(intent.project_id,intent.task_id,current_run.id,'task.launch_changed','system',NULL,
      jsonb_build_object('intentId',intent.id,'state',intent.state,'stateVersion',intent.state_version,'basis',intent.basis->>'kind'),clock_timestamp());
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER runs_settle_task_launch AFTER UPDATE OF status ON runs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.task_launch_intent_id IS NOT NULL AND NEW.status IN ('Done','Failed','Crashed','Abandoned'))
  EXECUTE FUNCTION settle_task_launch_for_terminal_run();
--> statement-breakpoint
CREATE FUNCTION guard_task_launch_continuation_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_launch_intent_id IS NOT NULL AND NEW.status IN ('Running','NeedsInput','HumanWorking')
    AND OLD.status NOT IN ('Running','NeedsInput','HumanWorking') AND NOT EXISTS(
      SELECT 1 FROM task_launch_intents intent WHERE intent.id=NEW.task_launch_intent_id
        AND intent.run_id=NEW.id AND intent.state='run_bound' AND intent.dispatch_receipt IS NOT NULL
    ) THEN
    RAISE EXCEPTION 'Execution continuation must reacquire its original launch reservation'
      USING ERRCODE='23514',CONSTRAINT='task_launch_continuation_reservation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER runs_task_launch_execution_reservation BEFORE UPDATE OF status ON runs
  FOR EACH ROW EXECUTE FUNCTION guard_task_launch_continuation_reservation();
