CREATE OR REPLACE FUNCTION public.guard_specialist_flow_question_resume()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$;
