ALTER TABLE "specialist_assignment_control_receipts" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "specialist_assignment_pending_cancel" ON "specialist_assignment_control_receipts" USING btree ("assignment_id") WHERE "specialist_assignment_control_receipts"."next_attempt_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "specialist_assignment_due_cancel" ON "specialist_assignment_control_receipts" USING btree ("next_attempt_at","assignment_id") WHERE "specialist_assignment_control_receipts"."next_attempt_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "specialist_assignment_control_receipts" ADD CONSTRAINT "specialist_assignment_pending_cancel_shape" CHECK ("specialist_assignment_control_receipts"."next_attempt_at" IS NULL OR ("specialist_assignment_control_receipts"."action"='cancel' AND "specialist_assignment_control_receipts"."status"='active' AND "specialist_assignment_control_receipts"."reason" IS NOT NULL));
--> statement-breakpoint
CREATE FUNCTION specialist_assignment_cancellation_pending(subject_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM specialist_assignment_control_receipts
    WHERE assignment_id=subject_id AND next_attempt_at IS NOT NULL
  )
$$;
--> statement-breakpoint
CREATE FUNCTION require_no_pending_specialist_cancellation(subject_id text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- The intent and business writes serialize on the assignment head. NOWAIT
  -- lets a Run/placement-first caller unwind instead of reversing lock order.
  PERFORM 1 FROM specialist_assignments WHERE id=subject_id FOR SHARE NOWAIT;
  IF specialist_assignment_cancellation_pending(subject_id) THEN
    RAISE EXCEPTION 'Assignment cancellation already owns settlement'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignment_cancellation_pending';
  END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION check_specialist_cancellation_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status<>'cancelled' AND specialist_assignment_cancellation_pending(NEW.id) THEN
    RAISE EXCEPTION 'Assignment cancellation already owns settlement'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignment_cancellation_pending';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER specialist_cancellation_head_guard BEFORE UPDATE ON specialist_assignments
  FOR EACH ROW EXECUTE FUNCTION check_specialist_cancellation_head();
--> statement-breakpoint
CREATE FUNCTION check_specialist_cancellation_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM require_no_pending_specialist_cancellation(NEW.assignment_id);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER specialist_cancellation_link_guard BEFORE INSERT ON specialist_run_links
  FOR EACH ROW EXECUTE FUNCTION check_specialist_cancellation_link();
--> statement-breakpoint
CREATE FUNCTION check_specialist_cancellation_run_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  candidate_run_id text;
  subject_id text;
BEGIN
  IF TG_TABLE_NAME='runs' THEN
    candidate_run_id := NEW.id;
  ELSE
    candidate_run_id := NEW.run_id;
  END IF;
  SELECT assignment_id INTO subject_id FROM specialist_run_links WHERE run_id=candidate_run_id;
  IF FOUND THEN
    PERFORM require_no_pending_specialist_cancellation(subject_id);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER specialist_cancellation_resume_guard BEFORE UPDATE OF status,execution_assignment_id ON runs
  FOR EACH ROW WHEN (NEW.status IN ('Pending','Running','NeedsInput') AND (
    NEW.status IS DISTINCT FROM OLD.status OR NEW.execution_assignment_id IS DISTINCT FROM OLD.execution_assignment_id
  )) EXECUTE FUNCTION check_specialist_cancellation_run_write();
--> statement-breakpoint
CREATE TRIGGER specialist_cancellation_command_guard BEFORE INSERT ON execution_commands
  FOR EACH ROW WHEN (NEW.kind IN ('session.create','session.prompt','session.input','session.steer','stand.dispatch'))
  EXECUTE FUNCTION check_specialist_cancellation_run_write();
--> statement-breakpoint
CREATE FUNCTION check_specialist_cancellation_dispatch_permit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject_id text;
BEGIN
  SELECT assignment_id INTO subject_id FROM stand_operations WHERE id=NEW.operation_id;
  IF FOUND THEN
    PERFORM require_no_pending_specialist_cancellation(subject_id);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER specialist_cancellation_dispatch_permit_guard BEFORE INSERT ON stand_authorization_permits
  FOR EACH ROW WHEN (NEW.purpose='dispatch') EXECUTE FUNCTION check_specialist_cancellation_dispatch_permit();
