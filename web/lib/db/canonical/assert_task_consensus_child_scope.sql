CREATE OR REPLACE FUNCTION public.assert_task_consensus_child_scope(candidate runs)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE proof jsonb:=candidate.task_admission_snapshot->'parent'; owner runs%ROWTYPE; attempt node_attempts%ROWTYPE; node jsonb; participant jsonb; latest_round integer;
BEGIN
  IF candidate.task_admission_snapshot->'version' IS DISTINCT FROM '3'::jsonb
    OR candidate.task_admission_snapshot->>'scope' IS DISTINCT FROM 'consensus_draft'
    OR candidate.run_kind<>'agent' OR candidate.agent_kind='operational' OR candidate.persistent
    OR candidate.agent_workspace IS DISTINCT FROM 'repo_read' OR coalesce(candidate.workspace_mode,'own')<>'own'
    OR candidate.task_launch_intent_id IS NOT NULL OR candidate.task_id IS NULL OR candidate.parent_run_id IS NULL
    OR proof->>'parentRunId' IS DISTINCT FROM candidate.parent_run_id OR proof->>'parentTaskId' IS DISTINCT FROM candidate.task_id
    OR proof->>'rootRunId' IS DISTINCT FROM candidate.root_run_id OR proof->>'agentId' IS DISTINCT FROM candidate.agent_id
    OR candidate.trigger_payload->>'kind' IS DISTINCT FROM 'consensus_draft'
    OR candidate.trigger_payload->>'nodeId' IS DISTINCT FROM proof->>'nodeId'
    OR candidate.trigger_payload->>'nodeAttemptId' IS DISTINCT FROM proof->>'nodeAttemptId'
    OR candidate.trigger_payload->'round' IS DISTINCT FROM proof->'round'
    OR candidate.trigger_payload->>'participantId' IS DISTINCT FROM proof->>'participantId'
    OR candidate.trigger_payload->>'participantKind' IS DISTINCT FROM proof->>'participantKind'
    OR jsonb_typeof(candidate.trigger_payload->'prompt') IS DISTINCT FROM 'string'
    OR task_launch_admission_digest(candidate.trigger_payload->'prompt') IS DISTINCT FROM proof->>'promptDigest' THEN
    RAISE EXCEPTION 'Consensus child must bind its exact parent node and participant request'
      USING ERRCODE='23514',CONSTRAINT='runs_consensus_child_scope';
  END IF;
  SELECT * INTO owner FROM runs WHERE id=candidate.parent_run_id AND project_id=candidate.project_id FOR SHARE;
  IF NOT FOUND OR owner.run_kind<>'flow' OR owner.agent_kind='operational' OR owner.task_id IS DISTINCT FROM candidate.task_id
    OR owner.status NOT IN ('Running','WaitingOnChildren') OR owner.current_step_id IS DISTINCT FROM proof->>'nodeId'
    OR owner.task_admission_snapshot IS NULL OR task_launch_admission_digest(owner.task_admission_snapshot) IS DISTINCT FROM proof->>'parentAdmissionDigest'
    OR coalesce(owner.root_run_id,owner.id) IS DISTINCT FROM candidate.root_run_id
    OR owner.task_admission_snapshot->'inputRevision' IS DISTINCT FROM candidate.task_admission_snapshot->'inputRevision' THEN
    RAISE EXCEPTION 'Consensus child requires its active admitted parent objective'
      USING ERRCODE='23514',CONSTRAINT='runs_consensus_parent_admission';
  END IF;
  SELECT * INTO attempt FROM node_attempts WHERE run_id=owner.id AND node_id=proof->>'nodeId' ORDER BY node_attempts.attempt DESC LIMIT 1 FOR SHARE;
  IF NOT FOUND OR attempt.id IS DISTINCT FROM proof->>'nodeAttemptId' OR attempt.node_type<>'consensus' OR attempt.status NOT IN ('Running','NeedsInput') THEN
    RAISE EXCEPTION 'Consensus child requires its current active node attempt'
      USING ERRCODE='23514',CONSTRAINT='runs_consensus_node_admission';
  END IF;
  SELECT declared INTO node FROM flow_revisions revision CROSS JOIN LATERAL jsonb_array_elements(revision.manifest->'nodes') declared
    WHERE revision.id=owner.flow_revision_id AND declared->>'id'=proof->>'nodeId' AND declared->>'type'='consensus';
  IF node IS NULL THEN
    RAISE EXCEPTION 'Consensus child requires its pinned consensus definition'
      USING ERRCODE='23514',CONSTRAINT='runs_consensus_manifest_admission';
  END IF;
  SELECT declared INTO participant FROM jsonb_array_elements(node->'participants') declared WHERE declared->>'id'=proof->>'participantId';
  IF participant IS NULL OR NOT (proof->>'participantKind'='agent' AND participant->>'agent'=candidate.agent_id
    OR proof->>'participantKind'='runner' AND participant ? 'runner' AND candidate.agent_id IS NULL) IS TRUE THEN
    RAISE EXCEPTION 'Consensus child participant is not declared by its pinned parent'
      USING ERRCODE='23514',CONSTRAINT='runs_consensus_participant_admission';
  END IF;
  SELECT coalesce(max((trigger_payload->>'round')::integer),0) INTO latest_round FROM runs
    WHERE parent_run_id=owner.id AND trigger_payload->>'kind'='consensus_draft' AND trigger_payload->>'nodeAttemptId'=attempt.id;
  IF (proof->>'round')::integer<greatest(1,latest_round) OR (proof->>'round')::integer>greatest(1,latest_round+1) THEN
    RAISE EXCEPTION 'Consensus child round is not the current parent request'
      USING ERRCODE='23514',CONSTRAINT='runs_consensus_round_admission';
  END IF;
END $function$;
