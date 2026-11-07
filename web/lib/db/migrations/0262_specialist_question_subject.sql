ALTER TABLE "hitl_requests" DROP CONSTRAINT "hitl_requests_agent_question_shape_check";--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD COLUMN "specialist_assignment_id" text;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD COLUMN "specialist_input_revision" integer;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD COLUMN "specialist_answer_input_revision" integer;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD CONSTRAINT "hitl_requests_specialist_assignment_id_specialist_assignments_id_fk" FOREIGN KEY ("specialist_assignment_id") REFERENCES "public"."specialist_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD CONSTRAINT "hitl_specialist_input_fk" FOREIGN KEY ("specialist_assignment_id","specialist_input_revision") REFERENCES "public"."specialist_input_revisions"("assignment_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD CONSTRAINT "hitl_specialist_answer_input_fk" FOREIGN KEY ("specialist_assignment_id","specialist_answer_input_revision") REFERENCES "public"."specialist_input_revisions"("assignment_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hitl_specialist_question_request_uq" ON "hitl_requests" USING btree ("specialist_assignment_id",("schema"->'assignmentQuestion'->>'principalKey'),("schema"->'assignmentQuestion'->>'requestKey')) WHERE "hitl_requests"."specialist_assignment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "hitl_specialist_question_history_idx" ON "hitl_requests" USING btree ("specialist_assignment_id","created_at","id") WHERE "hitl_requests"."specialist_assignment_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD CONSTRAINT "hitl_specialist_subject_check" CHECK ((("hitl_requests"."specialist_assignment_id" IS NULL AND "hitl_requests"."specialist_input_revision" IS NULL AND "hitl_requests"."specialist_answer_input_revision" IS NULL) OR ("hitl_requests"."specialist_assignment_id" IS NOT NULL AND "hitl_requests"."specialist_input_revision">0 AND "hitl_requests"."kind"='agent_question' AND "hitl_requests"."task_id" IS NULL AND ("hitl_requests"."specialist_answer_input_revision" IS NULL OR ("hitl_requests"."specialist_answer_input_revision">"hitl_requests"."specialist_input_revision" AND "hitl_requests"."responded_at" IS NOT NULL)))) IS TRUE);--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD CONSTRAINT "hitl_requests_agent_question_shape_check" CHECK ((
        "hitl_requests"."kind" = 'agent_question'
        AND (("hitl_requests"."task_id" IS NOT NULL AND "hitl_requests"."specialist_assignment_id" IS NULL) OR ("hitl_requests"."task_id" IS NULL AND "hitl_requests"."specialist_assignment_id" IS NOT NULL))
        AND "hitl_requests"."activation_state" IS NOT NULL
        AND "hitl_requests"."retrigger_mode" IS NOT NULL
        AND "hitl_requests"."schema" IS NOT NULL
      ) OR (
        "hitl_requests"."kind" <> 'agent_question'
        AND "hitl_requests"."task_id" IS NULL
        AND "hitl_requests"."activation_state" IS NULL
        AND "hitl_requests"."retrigger_mode" IS NULL
      ));--> statement-breakpoint
CREATE FUNCTION guard_specialist_question_subject() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  subject jsonb;
  source_execution runs%ROWTYPE;
  assignment specialist_assignments%ROWTYPE;
  original specialist_input_revisions%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.specialist_assignment_id IS NOT NULL THEN
      RAISE EXCEPTION 'Assignment question evidence is retained; close or answer the existing decision'
        USING ERRCODE='23514',CONSTRAINT='hitl_specialist_question_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND (OLD.specialist_assignment_id IS NOT NULL OR NEW.specialist_assignment_id IS NOT NULL) THEN
    IF OLD.specialist_assignment_id IS NULL OR
      ROW(NEW.id,NEW.run_id,NEW.step_id,NEW.kind,NEW.task_id,NEW.specialist_assignment_id,NEW.specialist_input_revision,NEW.schema,NEW.prompt,NEW.retrigger_mode,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.run_id,OLD.step_id,OLD.kind,OLD.task_id,OLD.specialist_assignment_id,OLD.specialist_input_revision,OLD.schema,OLD.prompt,OLD.retrigger_mode,OLD.created_at)
      OR (OLD.responded_at IS NOT NULL AND (NEW.responded_at IS DISTINCT FROM OLD.responded_at OR (NEW.response-'_agentResume') IS DISTINCT FROM (OLD.response-'_agentResume')))
      OR (OLD.specialist_answer_input_revision IS NOT NULL AND NEW.specialist_answer_input_revision IS DISTINCT FROM OLD.specialist_answer_input_revision)
      OR (NEW.activation_state IS DISTINCT FROM OLD.activation_state AND NOT (OLD.activation_state='pending_termination' AND NEW.activation_state IN ('active','failed'))) THEN
      RAISE EXCEPTION 'Assignment question subject, prompt, provenance and committed answer are immutable'
        USING ERRCODE='23514',CONSTRAINT='hitl_specialist_question_immutable';
    END IF;
    IF NEW.responded_at IS NOT NULL AND NEW.specialist_answer_input_revision IS NULL AND NOT (
      NEW.response IS NULL AND EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND status IN ('Done','Failed','Crashed','Abandoned'))
    ) THEN
      RAISE EXCEPTION 'A clarification answer requires its exact retained input revision'
        USING ERRCODE='23514',CONSTRAINT='hitl_specialist_question_answer';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.specialist_assignment_id IS NULL THEN RETURN NEW; END IF;
  subject:=NEW.schema->'assignmentQuestion';
  IF subject IS NULL OR jsonb_typeof(subject)<>'object' THEN
    RAISE EXCEPTION 'Assignment question requires its closed server subject'
      USING ERRCODE='23514',CONSTRAINT='hitl_specialist_question_reference';
  END IF;
  IF (NOT (subject ?& ARRAY['schemaVersion','assignmentId','inputRevision','inputSha256','contextRevision','expectedRevision','principalKey','requestKey','requestDigest','actor','sourceRestrictions'])
    OR subject-ARRAY['schemaVersion','assignmentId','inputRevision','inputSha256','contextRevision','expectedRevision','principalKey','requestKey','requestDigest','actor','sourceRestrictions']<>'{}'::jsonb
    OR subject->'schemaVersion'<>'1'::jsonb
    OR subject->>'assignmentId' IS DISTINCT FROM NEW.specialist_assignment_id
    OR subject->'inputRevision' IS DISTINCT FROM to_jsonb(NEW.specialist_input_revision)
    OR jsonb_typeof(subject->'actor')<>'object' OR jsonb_typeof(subject->'sourceRestrictions')<>'array'
    OR NOT coalesce((subject->>'inputSha256') ~ '^[a-f0-9]{64}$',false)
    OR NOT coalesce((subject->>'principalKey') ~ '^[a-f0-9]{64}$',false)
    OR NOT coalesce((subject->>'requestDigest') ~ '^[a-f0-9]{64}$',false)
    OR NOT coalesce((subject->>'requestKey') ~ '^[A-Za-z0-9._:-]{8,128}$',false)
    OR jsonb_typeof(subject->'contextRevision')<>'number' OR jsonb_typeof(subject->'expectedRevision')<>'number'
    OR NOT coalesce((subject->>'contextRevision') ~ '^(0|[1-9][0-9]{0,9})$',false)
    OR NOT coalesce((subject->>'expectedRevision') ~ '^[1-9][0-9]{0,9}$',false)
    OR octet_length(NEW.schema::text)>131072 OR char_length(NEW.prompt) NOT BETWEEN 1 AND 10000
    OR NEW.prompt !~ '[^[:space:]]' OR NEW.activation_state<>'pending_termination' OR NEW.retrigger_mode<>'agent'
    OR NEW.schema->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(NEW.schema->'fields') IS DISTINCT FROM 'array'
    OR NEW.schema->>'kind' IS DISTINCT FROM 'agent_question' OR NEW.schema->'agentPrompt'->'version' IS DISTINCT FROM '1'::jsonb
    OR NEW.response IS NOT NULL OR NEW.responded_at IS NOT NULL OR NEW.specialist_answer_input_revision IS NOT NULL) IS NOT FALSE THEN
    RAISE EXCEPTION 'Assignment question subject does not match its bounded native contract'
      USING ERRCODE='23514',CONSTRAINT='hitl_specialist_question_reference';
  END IF;
  SELECT * INTO source_execution FROM runs WHERE id=NEW.run_id FOR SHARE;
  SELECT * INTO assignment FROM specialist_assignments WHERE id=NEW.specialist_assignment_id FOR UPDATE;
  SELECT * INTO original FROM specialist_input_revisions WHERE assignment_id=NEW.specialist_assignment_id AND revision=NEW.specialist_input_revision FOR SHARE;
  IF (source_execution.id IS NULL OR assignment.id IS NULL OR original.assignment_id IS NULL
    OR source_execution.run_kind<>'agent' OR source_execution.agent_kind<>'operational' OR source_execution.status<>'Running'
    OR ROW(source_execution.project_id,source_execution.company_id) IS DISTINCT FROM ROW(assignment.project_id,assignment.company_id)
    OR assignment.status<>'active' OR assignment.input_revision<>NEW.specialist_input_revision
    OR subject->>'inputSha256' IS DISTINCT FROM original.digest
    OR subject->'contextRevision' IS DISTINCT FROM to_jsonb(assignment.context_revision)
    OR subject->'expectedRevision' IS DISTINCT FROM to_jsonb(assignment.revision)
    OR NOT EXISTS (SELECT 1 FROM specialist_run_links link WHERE link.assignment_id=assignment.id AND link.run_id=source_execution.id AND link.input_revision=original.revision AND link.role IN ('specialist','coordinator','continuation') AND link.work_id IS NULL)
    OR (SELECT count(*) FROM specialist_run_links current_link JOIN runs current_run ON current_run.id=current_link.run_id
      WHERE current_link.assignment_id=assignment.id AND current_link.input_revision=assignment.input_revision
        AND current_link.role IN ('specialist','coordinator','continuation') AND current_link.work_id IS NULL
        AND current_run.status IN ('Pending','Running','NeedsInput','NeedsInputIdle','WaitingOnChildren','Review'))<>1
    OR source_execution.knowledge_access->>'state' IS DISTINCT FROM 'complete'
    OR NOT coalesce((source_execution.knowledge_access->'restrictions') @> (subject->'sourceRestrictions'),false)
    OR NOT coalesce(subject->'sourceRestrictions' @> jsonb_build_array(jsonb_build_object('kind','assignment_input','assignmentId',assignment.id,'inputRevision',original.revision,'inputSha256',original.digest)),false)
    OR NOT EXISTS (
      SELECT 1 FROM execution_commands command
      JOIN agent_turns turn ON turn.id=NEW.schema->'agentPrompt'->>'turnId' AND turn.command_id=command.id
      JOIN execution_assignments fence ON fence.id=source_execution.execution_assignment_id AND fence.run_id=source_execution.id AND fence.state='active' AND fence.epoch=command.assignment_epoch
      JOIN run_session_incarnations incarnation ON incarnation.id=turn.incarnation_id AND incarnation.host_session_id=command.target_session_id
      WHERE command.id=NEW.schema->'agentPrompt'->>'commandId' AND command.run_id=source_execution.id
        AND command.kind='session.prompt' AND command.owner_kind='agent_turn'
        AND command.execution_assignment_id=fence.id AND turn.execution_assignment_id=fence.id AND turn.state='dispatched'
        AND NEW.schema->'agentPrompt'->>'assignmentId'=fence.id AND NEW.schema->'agentPrompt'->>'incarnationId'=incarnation.id
        AND NEW.schema->'agentPrompt'->'promptOrdinal'=to_jsonb(turn.ordinal)
        AND NEW.schema->>'supervisorSessionId'=command.target_session_id
    )) IS NOT FALSE THEN
    RAISE EXCEPTION 'Assignment question requires its exact active appointment, input, source capture and owned prompt'
      USING ERRCODE='23514',CONSTRAINT='hitl_specialist_question_reference';
  END IF;
  IF (NOT (subject->'actor' ?& ARRAY['kind','id','runId','attemptId'])
    OR (subject->'actor')-ARRAY['kind','id','runId','attemptId']<>'{}'::jsonb
    OR jsonb_typeof(subject->'actor'->'id')<>'string'
    OR char_length(subject->'actor'->>'id') NOT BETWEEN 1 AND 192
    OR NOT (
      (subject->'actor'->>'kind'='user' AND subject->'actor'->'runId'='null'::jsonb AND subject->'actor'->'attemptId'='null'::jsonb AND EXISTS(SELECT 1 FROM users WHERE id=subject->'actor'->>'id' AND account_status='active' AND NOT must_change_password))
      OR (subject->'actor'->>'kind'='agent' AND subject->'actor'->>'id'=source_execution.source_agent_id AND subject->'actor'->>'runId'=source_execution.id AND subject->'actor'->'attemptId'='null'::jsonb)
    )) IS NOT FALSE THEN
    RAISE EXCEPTION 'Assignment question attribution requires its actual user or executing professional'
      USING ERRCODE='23514',CONSTRAINT='hitl_specialist_question_reference';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER hitl_specialist_question_guard BEFORE INSERT OR UPDATE OR DELETE ON hitl_requests
FOR EACH ROW EXECUTE FUNCTION guard_specialist_question_subject();
