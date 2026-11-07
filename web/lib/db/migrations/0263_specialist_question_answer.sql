ALTER TABLE "hitl_requests" ADD COLUMN "specialist_answer" jsonb;
--> statement-breakpoint
-- Lineage only: callers still enforce current principal, owner, source and professional policy.
CREATE FUNCTION specialist_run_has_input(source_run text, subject_assignment text, requested_revision integer, requested_digest text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE retained(revision,digest,depth) AS (
    SELECT input.revision,input.digest,0 FROM specialist_run_links link
    JOIN specialist_input_revisions input ON input.assignment_id=link.assignment_id AND input.revision=link.input_revision
    WHERE link.run_id=source_run AND link.assignment_id=subject_assignment
      AND link.role IN ('specialist','coordinator','continuation') AND link.work_id IS NULL
    UNION ALL
    SELECT next_input.revision,next_input.digest,retained.depth+1 FROM retained
    JOIN hitl_requests question ON question.run_id=source_run AND question.specialist_assignment_id=subject_assignment
      AND question.specialist_input_revision=retained.revision AND question.kind='agent_question'
      AND question.activation_state='active' AND question.responded_at IS NOT NULL AND question.response IS NOT NULL
      AND question.superseded_at IS NULL AND question.specialist_answer IS NOT NULL
    JOIN specialist_input_revisions next_input ON next_input.assignment_id=subject_assignment AND next_input.revision=question.specialist_answer_input_revision
      AND next_input.digest=question.specialist_answer->>'inputSha256'
    WHERE retained.depth<32 AND next_input.revision>retained.revision
  ) SELECT EXISTS(SELECT 1 FROM retained WHERE revision=requested_revision AND digest=requested_digest)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_specialist_question_subject() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  subject jsonb;
  source_execution runs%ROWTYPE;
  assignment specialist_assignments%ROWTYPE;
  original specialist_input_revisions%ROWTYPE;
  answered specialist_input_revisions%ROWTYPE;
  answer jsonb;
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
      OR (OLD.specialist_answer IS NOT NULL AND NEW.specialist_answer IS DISTINCT FROM OLD.specialist_answer)
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
    IF NEW.specialist_answer_input_revision IS NOT NULL AND OLD.specialist_answer_input_revision IS NULL THEN
      answer:=NEW.specialist_answer;
      SELECT * INTO assignment FROM specialist_assignments WHERE id=NEW.specialist_assignment_id FOR UPDATE;
      SELECT * INTO source_execution FROM runs WHERE id=NEW.run_id FOR SHARE;
      SELECT * INTO original FROM specialist_input_revisions WHERE assignment_id=assignment.id AND revision=OLD.specialist_input_revision FOR SHARE;
      SELECT * INTO answered FROM specialist_input_revisions WHERE assignment_id=assignment.id AND revision=NEW.specialist_answer_input_revision FOR SHARE;
      IF (answer IS NULL OR jsonb_typeof(answer)<>'object'
        OR NOT (answer ?& ARRAY['schemaVersion','assignmentId','questionId','sourceRunId','sourceInputRevision','answeredInputRevision','expectedRevision','inputSha256','responseSha256','principalKey','requestKey','requestDigest','actor','acceptedAt'])
        OR answer-ARRAY['schemaVersion','assignmentId','questionId','sourceRunId','sourceInputRevision','answeredInputRevision','expectedRevision','inputSha256','responseSha256','principalKey','requestKey','requestDigest','actor','acceptedAt']<>'{}'::jsonb
        OR answer->'schemaVersion'<>'1'::jsonb OR answer->>'assignmentId' IS DISTINCT FROM assignment.id
        OR answer->>'questionId' IS DISTINCT FROM NEW.id OR answer->>'sourceRunId' IS DISTINCT FROM NEW.run_id
        OR answer->'sourceInputRevision' IS DISTINCT FROM to_jsonb(OLD.specialist_input_revision)
        OR answer->'answeredInputRevision' IS DISTINCT FROM to_jsonb(NEW.specialist_answer_input_revision)
        OR answer->'expectedRevision' IS DISTINCT FROM to_jsonb(assignment.revision)
        OR answer->>'inputSha256' IS DISTINCT FROM answered.digest
        OR answer->'actor' IS DISTINCT FROM answered.actor OR answered.actor IS DISTINCT FROM answered.authority_snapshot->'actor'
        OR answered.actor->>'kind' IS DISTINCT FROM 'user' OR answered.actor->'runId' IS DISTINCT FROM 'null'::jsonb OR answered.actor->'attemptId' IS DISTINCT FROM 'null'::jsonb
        OR NOT EXISTS(SELECT 1 FROM users WHERE id=answered.actor->>'id' AND account_status='active' AND NOT must_change_password)
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(answered.authority_snapshot->'witnesses') authority WHERE authority->>'kind' IN ('project_membership','project_administrator') OR (authority->>'kind'='company_grant' AND authority->>'action'='assignments:answer'))
        OR NOT coalesce(answer->>'responseSha256' ~ '^[a-f0-9]{64}$',false)
        OR NOT coalesce(answer->>'principalKey' ~ '^[a-f0-9]{64}$',false)
        OR NOT coalesce(answer->>'requestDigest' ~ '^[a-f0-9]{64}$',false)
        OR NOT coalesce(answer->>'requestKey' ~ '^[A-Za-z0-9._:-]{8,128}$',false)
        OR answer->>'acceptedAt' IS DISTINCT FROM to_char(NEW.responded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        OR octet_length(answer::text)>8192 OR octet_length(NEW.response::text)>32768 OR jsonb_typeof(NEW.response)<>'object' OR NEW.response ? '_agentResume'
        OR OLD.activation_state<>'active' OR OLD.superseded_at IS NOT NULL OR OLD.responded_at IS NOT NULL OR OLD.response IS NOT NULL
        OR assignment.status<>'waiting_input' OR assignment.input_revision<>OLD.specialist_input_revision
        OR NEW.specialist_answer_input_revision<>assignment.input_revision+1
        OR source_execution.status<>'NeedsInputIdle' OR source_execution.run_kind<>'agent' OR source_execution.agent_kind<>'operational'
        OR answered.assignment_id IS NULL OR original.assignment_id IS NULL
        OR answered.standing_definition IS DISTINCT FROM original.standing_definition OR answered.scheduled_request IS DISTINCT FROM original.scheduled_request
        OR NOT coalesce(answered.source_restrictions @> (OLD.schema->'assignmentQuestion'->'sourceRestrictions'),false)
        OR NOT specialist_run_has_input(NEW.run_id,assignment.id,original.revision,original.digest)
      ) IS NOT FALSE THEN
        RAISE EXCEPTION 'Clarification answer requires its exact current subject, human attribution and retained next input'
          USING ERRCODE='23514',CONSTRAINT='hitl_specialist_question_answer';
      END IF;
    ELSIF NEW.specialist_answer IS DISTINCT FROM OLD.specialist_answer THEN
      RAISE EXCEPTION 'Clarification receipt requires its exact first retained answer'
        USING ERRCODE='23514',CONSTRAINT='hitl_specialist_question_answer';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.specialist_assignment_id IS NULL THEN
    IF NEW.specialist_answer IS NOT NULL THEN RAISE EXCEPTION 'Legacy decisions cannot invent a native answer' USING ERRCODE='23514',CONSTRAINT='hitl_specialist_question_answer'; END IF;
    RETURN NEW;
  END IF;
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
    OR NEW.response IS NOT NULL OR NEW.responded_at IS NOT NULL OR NEW.specialist_answer_input_revision IS NOT NULL OR NEW.specialist_answer IS NOT NULL) IS NOT FALSE THEN
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
    OR NOT EXISTS (SELECT 1 FROM specialist_run_links link WHERE link.assignment_id=assignment.id AND link.run_id=source_execution.id AND specialist_run_has_input(link.run_id,assignment.id,original.revision,original.digest) AND link.role IN ('specialist','coordinator','continuation') AND link.work_id IS NULL)
    OR (SELECT count(*) FROM specialist_run_links current_link JOIN runs current_run ON current_run.id=current_link.run_id
      WHERE current_link.assignment_id=assignment.id AND specialist_run_has_input(current_link.run_id,assignment.id,original.revision,original.digest)
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
  RETURN NEW;
END;
$$;
