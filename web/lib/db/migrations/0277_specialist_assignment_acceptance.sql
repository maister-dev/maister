CREATE TABLE "specialist_acceptances" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"assignment_id" text NOT NULL,
	"expected_revision" integer NOT NULL,
	"input_revision" integer NOT NULL,
	"context_revision" integer NOT NULL,
	"result_id" text NOT NULL,
	"result_revision" integer NOT NULL,
	"run_id" text NOT NULL,
	"actor" jsonb NOT NULL,
	"authority_snapshot" jsonb NOT NULL,
	"verification_ids" jsonb NOT NULL,
	"request_key" text NOT NULL,
	"request_sha256" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specialist_acceptances_assignment_id_unique" UNIQUE("assignment_id"),
	CONSTRAINT "specialist_acceptances_shape_check" CHECK ((
        "specialist_acceptances"."expected_revision">0 AND "specialist_acceptances"."input_revision">0 AND "specialist_acceptances"."context_revision">=0 AND "specialist_acceptances"."result_revision">0
        AND (CASE WHEN jsonb_typeof("specialist_acceptances"."actor")='object' THEN
    "specialist_acceptances"."actor" ?& ARRAY['kind','id','runId','attemptId']
    AND "specialist_acceptances"."actor" - ARRAY['kind','id','runId','attemptId']='{}'::jsonb
    AND "specialist_acceptances"."actor"->>'kind' IN ('user','agent','system')
    AND jsonb_typeof("specialist_acceptances"."actor"->'id')='string'
    AND char_length("specialist_acceptances"."actor"->>'id') BETWEEN 1 AND 192
    AND ("specialist_acceptances"."actor"->'runId'='null'::jsonb OR (jsonb_typeof("specialist_acceptances"."actor"->'runId')='string' AND char_length("specialist_acceptances"."actor"->>'runId') BETWEEN 1 AND 128))
    AND ("specialist_acceptances"."actor"->'attemptId'='null'::jsonb OR (jsonb_typeof("specialist_acceptances"."actor"->'attemptId')='string' AND char_length("specialist_acceptances"."actor"->>'attemptId') BETWEEN 1 AND 128))
    ELSE false END) IS TRUE AND "specialist_acceptances"."actor"->>'kind'='user'
        AND "specialist_acceptances"."actor"->'runId'='null'::jsonb AND "specialist_acceptances"."actor"->'attemptId'='null'::jsonb
        AND "specialist_acceptances"."authority_snapshot"->'schemaVersion'='1'::jsonb AND "specialist_acceptances"."authority_snapshot"->'actor'="specialist_acceptances"."actor"
        AND pg_column_size("specialist_acceptances"."authority_snapshot")<=32768
        AND "specialist_acceptances"."verification_ids"='[]'::jsonb
        AND "specialist_acceptances"."request_key" ~ '^[A-Za-z0-9._:-]{8,128}$' AND "specialist_acceptances"."request_sha256" ~ '^[a-f0-9]{64}$'
        AND char_length("specialist_acceptances"."reason") BETWEEN 1 AND 2000
      ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "specialist_assignments" DROP CONSTRAINT "specialist_assignments_completion_unavailable_check";--> statement-breakpoint
ALTER TABLE "specialist_acceptances" ADD CONSTRAINT "specialist_acceptances_result_id_run_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."run_results"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_acceptances" ADD CONSTRAINT "specialist_acceptances_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_acceptances" ADD CONSTRAINT "specialist_acceptances_input_fk" FOREIGN KEY ("assignment_id","input_revision") REFERENCES "public"."specialist_input_revisions"("assignment_id","revision") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION specialist_final_result_id(subject_id text, selected_input integer, selected_run text, selected_result integer)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT result.id
  FROM specialist_assignments subject
  JOIN specialist_input_revisions input ON input.assignment_id=subject.id AND input.revision=selected_input
  JOIN specialist_run_links link ON link.assignment_id=subject.id AND link.run_id=selected_run
  JOIN runs source ON source.id=link.run_id
  JOIN run_results result ON result.run_id=source.id AND result.revision=selected_result
  WHERE subject.id=subject_id AND subject.input_revision=selected_input
    AND link.role IN ('specialist','coordinator','continuation') AND link.work_id IS NULL
    AND source.parent_run_id IS NULL AND source.status='Done'
    AND source.project_id IS NOT DISTINCT FROM subject.project_id
    AND source.company_id IS NOT DISTINCT FROM subject.company_id
    AND source.knowledge_access->>'state'='complete'
    AND specialist_run_has_input(source.id,subject.id,input.revision,input.digest)
    AND result.validity='valid' AND result.value IS NOT NULL
    AND source.result_contract->'required'='true'::jsonb
    AND input.objective_input->'expectedResult'->'required'='true'::jsonb
    AND result.schema_ref=input.objective_input->'expectedResult'->>'schemaRef'
    AND result.schema_version::text=input.objective_input->'expectedResult'->>'schemaVersion'
    AND result.schema_sha256=input.objective_input->'expectedResult'->>'sha256'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(input.objective_input->'verification') requirement
      WHERE requirement->'required'='true'::jsonb AND (
        requirement->>'kind' IS DISTINCT FROM 'result'
        OR (requirement->>'referenceId' IS NOT NULL AND requirement->>'referenceId'<>result.id)
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM specialist_work work LEFT JOIN runs child ON child.id=work.child_run_id
      WHERE work.assignment_id=subject.id AND work.input_revision=selected_input AND work.decision_state='open'
        AND (child.id IS NULL OR child.status NOT IN ('Done','Failed','Crashed','Abandoned'))
    )
$$;
--> statement-breakpoint
CREATE FUNCTION guard_specialist_final_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Final assignment acceptance is immutable'
      USING ERRCODE='23514',CONSTRAINT='specialist_acceptances_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM specialist_assignments subject
    JOIN users author ON author.id=NEW.actor->>'id' AND author.account_status='active'
    JOIN specialist_delivery_receipts witness ON witness.assignment_id=subject.id AND witness.input_revision=NEW.input_revision
      AND witness.run_id=NEW.run_id AND witness.result_revision=NEW.result_revision
    WHERE subject.id=NEW.assignment_id AND subject.status='awaiting_acceptance' AND subject.revision=NEW.expected_revision
      AND subject.input_revision=NEW.input_revision AND subject.context_revision=NEW.context_revision
      AND specialist_final_result_id(subject.id,NEW.input_revision,NEW.run_id,NEW.result_revision)=NEW.result_id
  ) THEN
    RAISE EXCEPTION 'Acceptance requires an exact eligible result and current assignment heads'
      USING ERRCODE='23514',CONSTRAINT='specialist_acceptances_result_required';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER specialist_final_acceptance_guard BEFORE INSERT OR UPDATE OR DELETE ON specialist_acceptances
FOR EACH ROW EXECUTE FUNCTION guard_specialist_final_acceptance();
--> statement-breakpoint
CREATE FUNCTION require_specialist_accepted_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM specialist_assignments subject
    WHERE subject.id=NEW.assignment_id AND subject.acceptance_id=NEW.id
      AND subject.status='completed' AND subject.revision=NEW.expected_revision+1
      AND EXISTS (
        SELECT 1 FROM domain_events event
        WHERE event.kind='specialist.assignment_changed'
          AND event.payload->>'assignmentId'=subject.id
          AND event.payload->'revision'=to_jsonb(subject.revision)
          AND event.payload->>'status'='completed' AND event.payload->>'cause'='acceptance'
      )
  ) THEN
    RAISE EXCEPTION 'Final acceptance and completed assignment must commit together'
      USING ERRCODE='23514',CONSTRAINT='specialist_acceptances_completed_head_required';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER specialist_acceptance_completed_head
AFTER INSERT ON specialist_acceptances DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_specialist_accepted_head();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_specialist_assignment_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.company_id,NEW.project_id,NEW.specialist_binding_id,NEW.requester,NEW.responsible,NEW.origin,NEW.destination,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.project_id,OLD.specialist_binding_id,OLD.requester,OLD.responsible,OLD.origin,OLD.destination,OLD.created_at) THEN
    RAISE EXCEPTION 'Assignment ownership, responsibility, origin and destination are immutable'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignments_identity_immutable';
  END IF;
  IF NEW.revision<>OLD.revision+1
    OR NEW.input_revision NOT IN (OLD.input_revision,OLD.input_revision+1)
    OR NEW.context_revision NOT IN (OLD.context_revision,OLD.context_revision+1) THEN
    RAISE EXCEPTION 'Assignment changes require the next business revision and coherent input/context heads'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignments_head_revision';
  END IF;
  IF OLD.status='completed' THEN
    RAISE EXCEPTION 'A completed assignment cannot be changed; submit independent work'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignments_completed_immutable';
  END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status='queued' AND NEW.status IN ('active','waiting_input','failed','cancelled'))
    OR (OLD.status='active' AND NEW.status IN ('waiting_input','waiting_children','waiting_resource','reconciling','awaiting_acceptance','failed','cancelled'))
    OR (OLD.status='waiting_input' AND NEW.status IN ('queued','failed','cancelled'))
    OR (OLD.status='waiting_input' AND NEW.status='active' AND NEW.input_revision=OLD.input_revision+1 AND EXISTS(
      SELECT 1 FROM hitl_requests question JOIN runs source ON source.id=question.run_id
      JOIN specialist_input_revisions input ON input.assignment_id=OLD.id AND input.revision=NEW.input_revision
      WHERE question.specialist_assignment_id=OLD.id AND question.specialist_input_revision=OLD.input_revision
        AND question.specialist_answer_input_revision=NEW.input_revision AND question.specialist_answer IS NOT NULL
        AND question.specialist_answer->>'inputSha256'=input.digest
        AND question.specialist_answer->'expectedRevision'=to_jsonb(OLD.revision)
        AND question.activation_state='active' AND question.responded_at IS NOT NULL AND question.response IS NOT NULL
        AND question.superseded_at IS NULL AND source.status='NeedsInputIdle'
    ))
    OR (OLD.status='waiting_children' AND NEW.status IN ('queued','failed','cancelled'))
    OR (OLD.status='waiting_resource' AND NEW.status IN ('queued','reconciling','failed','cancelled'))
    OR (OLD.status='reconciling' AND NEW.status IN ('queued','awaiting_acceptance','failed','cancelled'))
    OR (OLD.status='awaiting_acceptance' AND NEW.status IN ('queued','completed','failed','cancelled'))
    OR (OLD.status IN ('failed','cancelled') AND NEW.status IN ('queued','reconciling'))
  ) THEN
    RAISE EXCEPTION 'The requested assignment state transition is not allowed'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignments_transition';
  END IF;
  IF NEW.status='awaiting_acceptance' AND OLD.status IS DISTINCT FROM NEW.status AND NOT EXISTS (
    SELECT 1 FROM specialist_delivery_receipts witness
    WHERE witness.assignment_id=NEW.id AND witness.input_revision=NEW.input_revision
      AND specialist_final_result_id(NEW.id,NEW.input_revision,witness.run_id,witness.result_revision) IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Awaiting acceptance requires an eligible current root result'
      USING ERRCODE='23514',CONSTRAINT='specialist_assignments_result_ready_required';
  END IF;
  IF NEW.status='completed' AND NOT EXISTS (
    SELECT 1 FROM specialist_acceptances accepted
    WHERE accepted.id=NEW.acceptance_id AND accepted.assignment_id=NEW.id AND accepted.expected_revision=OLD.revision
      AND accepted.input_revision=NEW.input_revision AND accepted.context_revision=NEW.context_revision
  ) THEN
    RAISE EXCEPTION 'Assignment completion requires its exact acceptance receipt'
      USING ERRCODE='23514',CONSTRAINT='specialist_assignments_acceptance_required';
  END IF;
  RETURN NEW;
END;
$$;
