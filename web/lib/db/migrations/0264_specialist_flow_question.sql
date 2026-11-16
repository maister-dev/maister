ALTER TABLE "node_attempts" DROP CONSTRAINT "node_attempts_action_resume_check";--> statement-breakpoint
ALTER TABLE "node_attempts" ADD CONSTRAINT "node_attempts_action_resume_check" CHECK ("node_attempts"."action_resume" IS NULL OR (jsonb_typeof("node_attempts"."action_resume") = 'object' AND "node_attempts"."action_resume"->'version' = '1'::jsonb AND (("node_attempts"."action_resume"->>'kind' = 'clarification' AND jsonb_typeof("node_attempts"."action_resume"->'questionId')='string' AND jsonb_typeof("node_attempts"."action_resume"->'sourceIncarnationId')='string' AND ("node_attempts"."action_resume"->'answer'='null'::jsonb OR (jsonb_typeof("node_attempts"."action_resume"->'answer')='object' AND jsonb_typeof("node_attempts"."action_resume"->'answer'->'inputRevision')='number' AND "node_attempts"."action_resume"->'answer'->>'inputSha256' ~ '^[a-f0-9]{64}$' AND "node_attempts"."action_resume"->'answer'->>'receiptSha256' ~ '^[a-f0-9]{64}$' AND jsonb_typeof("node_attempts"."action_resume"->'answer'->'checkpointCommandId')='string'))) OR ("node_attempts"."action_resume"->>'kind' = 'interrupt' AND "node_attempts"."action_resume"->>'cause' IN ('operator', 'host_pressure')) OR ("node_attempts"."action_resume"->>'kind' = 'orchestrator' AND (NOT ("node_attempts"."action_resume" ? 'permissionResult') OR (jsonb_typeof("node_attempts"."action_resume"->'permissionResult') = 'object' AND "node_attempts"."action_resume"->'permissionResult'->'version' = '1'::jsonb AND "node_attempts"."action_resume"->'permissionResult'->>'kind' = 'permission_result' AND "node_attempts"."action_prompt_ordinal" > 0 AND "node_attempts"."action_resume"->'permissionResult'->'promptOrdinal' = to_jsonb("node_attempts"."action_prompt_ordinal" - 1) AND "node_attempts"."action_resume"->'permissionResult'->>'sourceCommandId' = "node_attempts"."action_resume"->>'sourceCommandId' AND "node_attempts"."action_resume"->'permissionResult'->>'sourceAssignmentId' = "node_attempts"."action_resume"->>'sourceAssignmentId' AND "node_attempts"."action_resume"->'permissionResult'->>'resumeSessionId' = "node_attempts"."action_resume"->>'resumeSessionId' AND jsonb_typeof("node_attempts"."action_resume"->'permissionResult'->'assignmentId') = 'string' AND jsonb_typeof("node_attempts"."action_resume"->'permissionResult'->'hitlRequestId') = 'string' AND jsonb_typeof("node_attempts"."action_resume"->'permissionResult'->'sourceRequestId') = 'string' AND jsonb_typeof("node_attempts"."action_resume"->'permissionResult'->'optionId') = 'string' AND jsonb_typeof("node_attempts"."action_resume"->'permissionResult'->'inputCommandId') = 'string' AND jsonb_typeof("node_attempts"."action_resume"->'permissionResult'->'checkpointCommandId') = 'string' AND jsonb_typeof("node_attempts"."action_resume"->'permissionResult'->'sourceIncarnationId') = 'string'))) OR (("node_attempts"."action_resume"->>'kind' = 'permission' OR ("node_attempts"."action_resume"->>'kind' = 'permission_continue' AND "node_attempts"."action_prompt_ordinal" > 0 AND jsonb_typeof("node_attempts"."action_resume"->'checkpointCommandId') = 'string' AND jsonb_typeof("node_attempts"."action_resume"->'inputCommandId') = 'string' AND jsonb_typeof("node_attempts"."action_resume"->'sourceIncarnationId') = 'string') OR ("node_attempts"."action_resume"->>'kind' = 'permission_result' AND "node_attempts"."action_completion"->>'commandId' = "node_attempts"."action_resume"->>'sourceCommandId' AND jsonb_typeof("node_attempts"."action_resume"->'checkpointCommandId') = 'string' AND jsonb_typeof("node_attempts"."action_resume"->'inputCommandId') = 'string' AND jsonb_typeof("node_attempts"."action_resume"->'sourceIncarnationId') = 'string')) AND jsonb_typeof("node_attempts"."action_resume"->'hitlRequestId') = 'string' AND jsonb_typeof("node_attempts"."action_resume"->'sourceRequestId') = 'string' AND jsonb_typeof("node_attempts"."action_resume"->'optionId') = 'string')) AND jsonb_typeof("node_attempts"."action_resume"->'sourceCommandId') = 'string' AND jsonb_typeof("node_attempts"."action_resume"->'sourceAssignmentId') = 'string' AND "node_attempts"."action_resume"->>'assignmentId' = "node_attempts"."execution_assignment_id" AND "node_attempts"."action_resume"->'promptOrdinal' = to_jsonb("node_attempts"."action_prompt_ordinal") AND jsonb_typeof("node_attempts"."action_resume"->'resumeSessionId') = 'string') IS TRUE);
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
        OR source_execution.status<>'NeedsInputIdle' OR NOT ((source_execution.run_kind='agent' AND source_execution.agent_kind='operational' AND NEW.schema ? 'agentPrompt') OR (source_execution.run_kind='flow' AND NEW.schema ? 'flowQuestion' AND EXISTS(SELECT 1 FROM node_attempts node WHERE node.id=NEW.schema->'flowQuestion'->>'nodeAttemptId' AND node.run_id=NEW.run_id AND node.node_id=NEW.step_id AND node.status='NeedsInput' AND node.action_resume->>'kind'='clarification' AND node.action_resume->>'questionId'=NEW.id)))
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
    OR NEW.schema->>'kind' IS DISTINCT FROM 'agent_question' OR NOT (((NEW.schema ? 'agentPrompt') AND NOT (NEW.schema ? 'flowQuestion') AND NEW.schema->'agentPrompt'->'version'='1'::jsonb) OR ((NEW.schema ? 'flowQuestion') AND NOT (NEW.schema ? 'agentPrompt') AND NEW.schema->'flowQuestion'->'version'='1'::jsonb))
    OR NEW.response IS NOT NULL OR NEW.responded_at IS NOT NULL OR NEW.specialist_answer_input_revision IS NOT NULL OR NEW.specialist_answer IS NOT NULL) IS NOT FALSE THEN
    RAISE EXCEPTION 'Assignment question subject does not match its bounded native contract'
      USING ERRCODE='23514',CONSTRAINT='hitl_specialist_question_reference';
  END IF;
  SELECT * INTO source_execution FROM runs WHERE id=NEW.run_id FOR SHARE;
  SELECT * INTO assignment FROM specialist_assignments WHERE id=NEW.specialist_assignment_id FOR UPDATE;
  SELECT * INTO original FROM specialist_input_revisions WHERE assignment_id=NEW.specialist_assignment_id AND revision=NEW.specialist_input_revision FOR SHARE;
  IF (source_execution.id IS NULL OR assignment.id IS NULL OR original.assignment_id IS NULL
    OR NOT ((source_execution.run_kind='agent' AND source_execution.agent_kind='operational' AND NEW.schema ? 'agentPrompt') OR (source_execution.run_kind='flow' AND NEW.schema ? 'flowQuestion')) OR source_execution.status<>'Running'
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
    OR NOT ((source_execution.run_kind='agent' AND EXISTS (
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
    )) OR (source_execution.run_kind='flow' AND EXISTS (
      SELECT 1 FROM execution_commands command
      JOIN node_attempts node ON node.id=NEW.schema->'flowQuestion'->>'nodeAttemptId'
        AND node.run_id=source_execution.id AND node.node_id=source_execution.current_step_id AND node.node_id=NEW.step_id
        AND node.status='Running' AND node.node_type IN ('ai_coding','orchestrator')
        AND node.action_prompt_ordinal=(NEW.schema->'flowQuestion'->>'promptOrdinal')::integer
      JOIN execution_assignments fence ON fence.id=source_execution.execution_assignment_id AND fence.run_id=source_execution.id AND fence.state='active' AND fence.epoch=command.assignment_epoch
      JOIN run_session_incarnations incarnation ON incarnation.id=NEW.schema->'flowQuestion'->>'incarnationId'
        AND incarnation.run_id=source_execution.id AND incarnation.execution_assignment_id=fence.id
        AND incarnation.execution_host_id=command.execution_host_id AND incarnation.assignment_epoch=fence.epoch
        AND incarnation.host_session_id=command.target_session_id AND incarnation.acp_session_id IS NOT NULL
      WHERE command.id=NEW.schema->'flowQuestion'->>'commandId' AND command.run_id=source_execution.id
        AND command.kind='session.prompt' AND command.owner_kind='flow_node_attempt' AND command.state='accepted'
        AND command.execution_assignment_id=fence.id AND node.execution_assignment_id=fence.id
        AND command.owner_ref->>'nodeAttemptId'=node.id AND command.owner_ref->'promptOrdinal'=to_jsonb(node.action_prompt_ordinal)
        AND command.owner_ref->>'assignmentId'=fence.id AND command.owner_ref->'assignmentEpoch'=to_jsonb(fence.epoch)
        AND command.owner_ref->>'incarnationId'=incarnation.id
        AND command.owner_ref->>'variant' IN ('node','permission_resume')
        AND NEW.schema->'flowQuestion'->>'assignmentId'=fence.id AND NEW.schema->>'supervisorSessionId'=command.target_session_id
    )))
    ) IS NOT FALSE THEN
    RAISE EXCEPTION 'Assignment question requires its exact active appointment, input, source capture and owned prompt'
      USING ERRCODE='23514',CONSTRAINT='hitl_specialist_question_reference';
  END IF;
  IF (NOT (subject->'actor' ?& ARRAY['kind','id','runId','attemptId'])
    OR (subject->'actor')-ARRAY['kind','id','runId','attemptId']<>'{}'::jsonb
    OR jsonb_typeof(subject->'actor'->'id')<>'string'
    OR char_length(subject->'actor'->>'id') NOT BETWEEN 1 AND 192
    OR NOT (
      (subject->'actor'->>'kind'='user' AND subject->'actor'->'runId'='null'::jsonb AND subject->'actor'->'attemptId'='null'::jsonb AND EXISTS(SELECT 1 FROM users WHERE id=subject->'actor'->>'id' AND account_status='active' AND NOT must_change_password))
      OR (source_execution.run_kind='agent' AND subject->'actor'->>'kind'='agent' AND subject->'actor'->>'id'=source_execution.source_agent_id AND subject->'actor'->>'runId'=source_execution.id AND subject->'actor'->'attemptId'='null'::jsonb)
      OR (source_execution.run_kind='flow' AND subject->'actor'->>'kind'='agent' AND subject->'actor'->>'runId'=source_execution.id AND EXISTS(
        SELECT 1 FROM node_attempts node WHERE node.id=NEW.schema->'flowQuestion'->>'nodeAttemptId' AND node.run_id=source_execution.id
          AND subject->'actor'->>'attemptId'=node.id AND subject->'actor'->>'id'=node.knowledge_actor->>'agentId'
      ))
    )) IS NOT FALSE THEN
    RAISE EXCEPTION 'Assignment question attribution requires its actual user or executing professional'
      USING ERRCODE='23514',CONSTRAINT='hitl_specialist_question_reference';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_specialist_flow_question_resume() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE question hitl_requests%ROWTYPE; proof jsonb; answer jsonb; source execution_commands%ROWTYPE; incarnation run_session_incarnations%ROWTYPE;
BEGIN
  IF NEW.action_resume->>'kind' IS DISTINCT FROM 'clarification' THEN RETURN NEW; END IF;
  SELECT * INTO question FROM hitl_requests WHERE id=NEW.action_resume->>'questionId' FOR SHARE;
  proof:=question.schema->'flowQuestion'; answer:=NEW.action_resume->'answer';
  SELECT * INTO source FROM execution_commands WHERE id=NEW.action_resume->>'sourceCommandId' FOR SHARE;
  SELECT * INTO incarnation FROM run_session_incarnations WHERE id=NEW.action_resume->>'sourceIncarnationId' FOR SHARE;
  IF (question.id IS NULL OR question.kind<>'agent_question' OR question.specialist_assignment_id IS NULL
    OR question.run_id<>NEW.run_id OR question.step_id<>NEW.node_id
    OR proof->>'nodeAttemptId' IS DISTINCT FROM NEW.id OR proof->>'commandId' IS DISTINCT FROM source.id
    OR proof->>'assignmentId' IS DISTINCT FROM NEW.action_resume->>'sourceAssignmentId'
    OR proof->>'incarnationId' IS DISTINCT FROM incarnation.id
    OR (proof->>'promptOrdinal')::integer+1<>NEW.action_prompt_ordinal
    OR source.run_id<>NEW.run_id OR source.owner_kind<>'flow_node_attempt' OR source.kind<>'session.prompt'
    OR source.execution_assignment_id IS DISTINCT FROM NEW.action_resume->>'sourceAssignmentId'
    OR incarnation.execution_assignment_id<>source.execution_assignment_id OR incarnation.host_session_id IS DISTINCT FROM source.target_session_id
    OR incarnation.acp_session_id IS DISTINCT FROM NEW.action_resume->>'resumeSessionId'
    OR NEW.action_resume-ARRAY['version','kind','questionId','sourceCommandId','sourceAssignmentId','assignmentId','sourceIncarnationId','promptOrdinal','resumeSessionId','answer']<>'{}'::jsonb
    OR (NEW.execution_assignment_id=source.execution_assignment_id AND (
      answer IS DISTINCT FROM 'null'::jsonb OR incarnation.state NOT IN ('checkpointed','exited')
      OR NOT EXISTS(SELECT 1 FROM execution_assignments parked JOIN execution_commands checkpoint ON checkpoint.execution_assignment_id=parked.id
        WHERE parked.id=source.execution_assignment_id AND parked.run_id=NEW.run_id AND parked.state='released' AND parked.released_reason='checkpointed'
          AND checkpoint.kind='session.checkpoint' AND checkpoint.run_id=NEW.run_id AND checkpoint.assignment_epoch=parked.epoch
          AND checkpoint.target_session_id=source.target_session_id AND checkpoint.state='succeeded')
    ))
    OR (NEW.execution_assignment_id<>source.execution_assignment_id AND (
      answer IS NULL OR jsonb_typeof(answer)<>'object' OR question.specialist_answer IS NULL
      OR question.responded_at IS NULL OR question.response IS NULL OR question.superseded_at IS NOT NULL OR question.activation_state<>'active'
      OR answer->'inputRevision' IS DISTINCT FROM to_jsonb(question.specialist_answer_input_revision)
      OR answer->>'inputSha256' IS DISTINCT FROM question.specialist_answer->>'inputSha256'
      OR NOT EXISTS(SELECT 1 FROM execution_assignments successor JOIN execution_assignments predecessor ON predecessor.id=source.execution_assignment_id
        WHERE successor.id=NEW.execution_assignment_id AND successor.run_id=NEW.run_id
          AND successor.execution_host_id=predecessor.execution_host_id AND successor.epoch>predecessor.epoch
          AND predecessor.state='released' AND predecessor.released_reason='checkpointed')
      OR NOT EXISTS(SELECT 1 FROM execution_commands checkpoint WHERE checkpoint.id=answer->>'checkpointCommandId'
        AND checkpoint.kind='session.checkpoint' AND checkpoint.run_id=NEW.run_id AND checkpoint.execution_assignment_id=source.execution_assignment_id
        AND checkpoint.assignment_epoch=source.assignment_epoch AND checkpoint.target_session_id=source.target_session_id AND checkpoint.state='succeeded')
    ))) IS NOT FALSE THEN
    RAISE EXCEPTION 'Native clarification resume requires its exact retained question, prompt, incarnation and answered input'
      USING ERRCODE='23514',CONSTRAINT='specialist_flow_question_resume';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER specialist_flow_question_resume_guard BEFORE INSERT OR UPDATE ON node_attempts
FOR EACH ROW EXECUTE FUNCTION guard_specialist_flow_question_resume();
