ALTER TABLE "agents" ADD COLUMN "task_qualification" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "task_admission_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_task_qualification_check" CHECK ("agents"."task_qualification" IS NULL OR (jsonb_typeof("agents"."task_qualification")='object' AND "agents"."task_qualification"->>'contract'='v1' AND "agents"."task_qualification"->>'role' IN ('intake','qualifier') AND "agents"."task_qualification"-ARRAY['contract','role']='{}'::jsonb AND "agents"."kind"='operational' AND "agents"."mode"='session' AND ("agents"."task_qualification"->>'role'<>'qualifier' OR "agents"."workspace"='repo_read' AND "agents"."workspace_ref"='task_target')) IS TRUE);
--> statement-breakpoint
-- Older binaries cannot ready or dispatch a task governed by the qualification contract.
CREATE FUNCTION guard_task_qualification_writer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mode text;
BEGIN
  IF TG_TABLE_NAME='tasks' THEN
    mode:=NEW.qualification_mode;
  ELSE
    mode:=NEW.task_admission_snapshot->>'mode';
  END IF;
  IF mode IN ('required','execution_child') AND current_setting('maister.task_qualification_writer',true) IS DISTINCT FROM 'v1' THEN
    RAISE EXCEPTION 'task qualification writer v1 is required; keep incompatible writers stopped under upgrade maintenance'
      USING ERRCODE='23514',CONSTRAINT='task_qualification_writer_capability';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER tasks_qualification_writer BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION guard_task_qualification_writer();
--> statement-breakpoint
CREATE TRIGGER runs_qualification_writer BEFORE INSERT OR UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION guard_task_qualification_writer();
--> statement-breakpoint
CREATE FUNCTION guard_task_qualification_ready() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assessment task_qualifications%ROWTYPE;
BEGIN
  IF NEW.qualification_mode<>'required' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.qualification_input_revision>OLD.qualification_input_revision THEN
    NEW.triage_status:=NULL;
  END IF;
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
CREATE TRIGGER tasks_qualification_ready_guard BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION guard_task_qualification_ready();
--> statement-breakpoint
CREATE FUNCTION guard_new_task_delivery_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target tasks%ROWTYPE;
BEGIN
  IF NEW.task_id IS NULL OR NEW.agent_kind='operational' THEN RETURN NEW; END IF;
  SELECT * INTO target FROM tasks WHERE id=NEW.task_id AND project_id=NEW.project_id;
  IF NOT FOUND OR target.qualification_mode='legacy' THEN RETURN NEW; END IF;
  IF NEW.task_admission_snapshot IS NULL OR NEW.task_admission_snapshot->>'mode' IS DISTINCT FROM target.qualification_mode
    OR (NEW.task_admission_snapshot->>'inputRevision')::int<>target.qualification_input_revision
    OR (target.qualification_mode='required' AND (NEW.task_admission_snapshot->>'qualificationId' IS DISTINCT FROM target.current_qualification_id
      OR (NEW.task_admission_snapshot->>'qualificationRevision')::int IS DISTINCT FROM target.current_qualification_revision))
    OR (target.qualification_mode='execution_child' AND NEW.task_admission_snapshot->'parent' IS DISTINCT FROM target.qualification_child_proof) THEN
    RAISE EXCEPTION 'delivery admission must bind the current task qualification'
      USING ERRCODE='23514',CONSTRAINT='runs_task_delivery_admission_required';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER runs_task_delivery_admission BEFORE INSERT ON runs
  FOR EACH ROW EXECUTE FUNCTION guard_new_task_delivery_admission();
--> statement-breakpoint
CREATE FUNCTION guard_task_admission_dispatch_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.task_admission_checked_at IS NOT NULL AND OLD.task_admission_checked_at IS DISTINCT FROM NEW.task_admission_checked_at
    OR NEW.task_admission_checked_at IS NOT NULL AND NEW.task_admission_snapshot IS NULL THEN
    RAISE EXCEPTION 'first task dispatch receipt is write-once and requires its frozen admission'
      USING ERRCODE='23514',CONSTRAINT='runs_task_dispatch_receipt_immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER runs_task_dispatch_receipt BEFORE UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION guard_task_admission_dispatch_receipt();

--> statement-breakpoint
CREATE FUNCTION invalidate_execution_child_relation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind='parent_of' THEN
    UPDATE tasks SET qualification_mode='required',qualification_child_proof=NULL,
      qualification_input_revision=qualification_input_revision+1
    WHERE id=OLD.to_task_id AND qualification_mode='execution_child'
      AND qualification_child_proof->>'relationId'=OLD.id;
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_relations_execution_child_invalidation AFTER DELETE ON task_relations
  FOR EACH ROW EXECUTE FUNCTION invalidate_execution_child_relation();
