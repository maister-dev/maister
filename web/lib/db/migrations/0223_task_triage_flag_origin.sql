ALTER TABLE "tasks" ADD COLUMN "triage_flag_origin" text;--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_task_qualification_ready() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assessment task_qualifications%ROWTYPE;
BEGIN
  IF NEW.qualification_mode='required' AND TG_OP='UPDATE'
    AND NEW.qualification_input_revision>OLD.qualification_input_revision THEN
    IF OLD.triage_status='flagged' AND OLD.triage_flag_origin IS DISTINCT FROM 'qualification' THEN
      NEW.triage_status:='flagged'; NEW.triage_flag_origin:=OLD.triage_flag_origin;
      NEW.launch_mode:=NULL; NEW.launch_armed_at:=NULL;
    ELSE
      NEW.triage_status:=NULL; NEW.triage_flag_origin:=NULL;
    END IF;
  END IF;
  IF NEW.triage_status IS DISTINCT FROM 'flagged' THEN NEW.triage_flag_origin:=NULL; END IF;
  IF NEW.qualification_mode<>'required' THEN RETURN NEW; END IF;
  IF NEW.triage_status IS DISTINCT FROM 'triaged' AND NEW.launch_mode IS DISTINCT FROM 'auto' THEN RETURN NEW; END IF;
  SELECT * INTO assessment FROM task_qualifications WHERE id=NEW.current_qualification_id
    AND task_id=NEW.id AND project_id=NEW.project_id;
  IF NOT FOUND OR assessment.publication_state<>'accepted' OR assessment.value->>'decision'<>'ready'
    OR assessment.input_revision<>NEW.qualification_input_revision OR assessment.revision<>NEW.current_qualification_revision THEN
    RAISE EXCEPTION 'required task cannot be readied or enqueued without current accepted qualification'
      USING ERRCODE='23514',CONSTRAINT='tasks_qualification_readiness_required';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
UPDATE "tasks" SET "triage_flag_origin"='unknown' WHERE "triage_status"='flagged';--> statement-breakpoint
SET CONSTRAINTS ALL IMMEDIATE;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_triage_flag_origin_check" CHECK ((("tasks"."triage_status"='flagged' AND "tasks"."triage_flag_origin" IN ('qualification','explicit','dispatch_failure','unknown')) OR ("tasks"."triage_status" IS DISTINCT FROM 'flagged' AND "tasks"."triage_flag_origin" IS NULL)) IS TRUE);--> statement-breakpoint
-- Reuse the task row fence; never take an advisory, run or intent lock here.
CREATE FUNCTION guard_task_launch_manual_hold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE held boolean;
BEGIN
  IF NEW.basis->>'kind' IS DISTINCT FROM 'manual'
    OR NEW.state NOT IN ('queued','preparing','run_bound') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.dispatch_committed_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT (triage_status='flagged' AND triage_flag_origin IS DISTINCT FROM 'qualification') IS TRUE
    INTO held FROM tasks WHERE id=NEW.task_id AND project_id=NEW.project_id FOR UPDATE;
  IF held THEN
    RAISE EXCEPTION 'Manual task launch requires a fresh resolution of its independent hold'
      USING ERRCODE='23514',CONSTRAINT='task_launch_manual_hold';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- After the shared reservation's task lock and before the main intent guard.
CREATE TRIGGER task_launch_intents_01_manual_hold
  BEFORE INSERT OR UPDATE OF state,reservation_lane,dispatch_committed_at ON task_launch_intents
  FOR EACH ROW EXECUTE FUNCTION guard_task_launch_manual_hold();
