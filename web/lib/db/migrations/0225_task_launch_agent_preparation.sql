ALTER TABLE "runs" DROP CONSTRAINT "runs_task_admission_snapshot_check";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_operational_baseline_check";--> statement-breakpoint
ALTER TABLE "task_launch_intents" DROP CONSTRAINT "task_launch_intents_preparation_check";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_admission_snapshot_check" CHECK ("runs"."task_admission_snapshot" IS NULL OR ("runs"."task_id" IS NOT NULL AND jsonb_typeof("runs"."task_admission_snapshot")='object' AND jsonb_typeof("runs"."task_admission_snapshot"->'inputRevision')='number' AND ("runs"."task_admission_snapshot"->>'mode'<>'required' OR jsonb_typeof("runs"."task_admission_snapshot"->'qualificationId')='string' AND jsonb_typeof("runs"."task_admission_snapshot"->'qualificationRevision')='number' AND "runs"."task_admission_snapshot"->>'evidenceSha' ~ '^[a-f0-9]{40}([a-f0-9]{24})?$') AND ("runs"."task_admission_snapshot"->>'mode'<>'execution_child' OR jsonb_typeof("runs"."task_admission_snapshot"->'parent')='object') AND (("runs"."task_launch_intent_id" IS NULL AND "runs"."task_admission_snapshot"->'version'='1'::jsonb AND "runs"."task_admission_snapshot"->'policyVersion'='1'::jsonb AND "runs"."task_admission_snapshot"->>'mode' IN ('legacy','required','execution_child')) OR ("runs"."task_launch_intent_id" IS NOT NULL AND "runs"."task_admission_snapshot"->'version'='2'::jsonb AND "runs"."task_admission_snapshot"->'policyVersion'='2'::jsonb AND "runs"."task_admission_snapshot"->>'intentId'="runs"."task_launch_intent_id" AND "runs"."task_admission_snapshot"->>'mode' IN ('manual','required','execution_child') AND "runs"."task_admission_snapshot"->>'basis'=CASE "runs"."task_admission_snapshot"->>'mode' WHEN 'manual' THEN 'manual' WHEN 'required' THEN 'automatic' ELSE 'execution_child' END AND "runs"."task_admission_snapshot"-ARRAY['version','policyVersion','mode','inputRevision','qualificationId','qualificationRevision','evidenceTarget','evidenceSha','parent','intentId','basis']='{}'::jsonb AND ("runs"."task_admission_snapshot"->>'mode'<>'manual' OR "runs"."task_admission_snapshot"->'qualificationId'='null'::jsonb AND "runs"."task_admission_snapshot"->'qualificationRevision'='null'::jsonb AND "runs"."task_admission_snapshot"->'parent'='null'::jsonb AND ("runs"."task_admission_snapshot"->>'evidenceSha' ~ '^[a-f0-9]{40}([a-f0-9]{24})?$' OR "runs"."run_kind"='agent' AND "runs"."agent_workspace"='none' AND "runs"."task_admission_snapshot"->'evidenceSha'='null'::jsonb))) OR ("runs"."task_launch_intent_id" IS NULL AND "runs"."run_kind"='agent' AND "runs"."persistent"=false
        AND "runs"."task_admission_snapshot"->'version'='3'::jsonb AND "runs"."task_admission_snapshot"->'policyVersion'='3'::jsonb
        AND "runs"."task_admission_snapshot"->>'mode'='execution_child' AND "runs"."task_admission_snapshot"->>'basis'='execution_child' AND "runs"."task_admission_snapshot"->>'scope'='consensus_draft'
        AND ("runs"."task_admission_snapshot"->>'inputRevision')::numeric>0 AND ("runs"."task_admission_snapshot"->>'inputRevision')::numeric=trunc(("runs"."task_admission_snapshot"->>'inputRevision')::numeric)
        AND "runs"."task_admission_snapshot"->'parent'->>'parentRunId'="runs"."parent_run_id" AND "runs"."task_admission_snapshot"->'parent'->>'parentTaskId'="runs"."task_id"
        AND "runs"."task_admission_snapshot"->'parent'->>'rootRunId'="runs"."root_run_id"
        AND "runs"."task_admission_snapshot"->'parent'->>'parentAdmissionDigest' ~ '^[0-9a-f]{64}$'
        AND length("runs"."task_admission_snapshot"->'parent'->>'nodeAttemptId') BETWEEN 1 AND 256 AND length("runs"."task_admission_snapshot"->'parent'->>'nodeId') BETWEEN 1 AND 256
        AND jsonb_typeof("runs"."task_admission_snapshot"->'parent'->'round')='number' AND ("runs"."task_admission_snapshot"->'parent'->>'round')::numeric>0 AND ("runs"."task_admission_snapshot"->'parent'->>'round')::numeric=trunc(("runs"."task_admission_snapshot"->'parent'->>'round')::numeric)
        AND length("runs"."task_admission_snapshot"->'parent'->>'participantId') BETWEEN 1 AND 256 AND "runs"."task_admission_snapshot"->'parent'->>'participantKind' IN ('runner','agent')
        AND length("runs"."task_admission_snapshot"->'parent'->>'runnerId') BETWEEN 1 AND 256
        AND ("runs"."task_admission_snapshot"->'parent'->>'agentId' IS NOT DISTINCT FROM "runs"."agent_id")
        AND "runs"."task_admission_snapshot"->'parent'->>'promptDigest' ~ '^[0-9a-f]{64}$' AND "runs"."task_admission_snapshot"->'parent'->>'manifestDigest' ~ '^[0-9a-f]{64}$'
        AND "runs"."task_admission_snapshot"-ARRAY['version','policyVersion','mode','basis','scope','inputRevision','parent']='{}'::jsonb
        AND ("runs"."task_admission_snapshot"->'parent')-ARRAY['parentRunId','parentTaskId','rootRunId','parentAdmissionDigest','nodeAttemptId','nodeId','round','participantId','participantKind','runnerId','agentId','promptDigest','manifestDigest']='{}'::jsonb
      ))) IS TRUE);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_operational_baseline_check" CHECK ("runs"."operational_integrity_baseline" IS NULL OR (("runs"."agent_kind" = 'operational' OR "runs"."run_kind"='agent' AND "runs"."agent_kind"='code_delivery' AND "runs"."task_launch_intent_id" IS NOT NULL) AND jsonb_typeof("runs"."operational_integrity_baseline") = 'object' AND "runs"."operational_integrity_baseline"->'version' = '1'::jsonb AND jsonb_typeof("runs"."operational_integrity_baseline"->'generation') = 'number' AND jsonb_typeof("runs"."operational_integrity_baseline"->'source') = 'array' AND jsonb_typeof("runs"."operational_integrity_baseline"->'platform') = 'array' AND pg_column_size("runs"."operational_integrity_baseline") <= 16777216) IS TRUE);--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD CONSTRAINT "task_launch_intents_preparation_check" CHECK ((("task_launch_intents"."preparation_identity" IS NULL AND "task_launch_intents"."preparation_phase" IS NULL) OR (
        jsonb_typeof("task_launch_intents"."preparation_identity")='object' AND "task_launch_intents"."preparation_identity" ?& ARRAY['runId','taskAttemptNumber','branch','parentRepoPath','worktreePath','resourceId','incarnationId','baseCommit','inputDigest','settingsDigest']
        AND length("task_launch_intents"."preparation_identity"->>'runId') BETWEEN 1 AND 256
        AND jsonb_typeof("task_launch_intents"."preparation_identity"->'taskAttemptNumber')='number' AND ("task_launch_intents"."preparation_identity"->>'taskAttemptNumber')::numeric>0 AND ("task_launch_intents"."preparation_identity"->>'taskAttemptNumber')::numeric=trunc(("task_launch_intents"."preparation_identity"->>'taskAttemptNumber')::numeric)
        AND "task_launch_intents"."preparation_identity"->>'resourceId' ~ '^[0-9a-f]{64}$' AND length("task_launch_intents"."preparation_identity"->>'incarnationId') BETWEEN 1 AND 256
        AND jsonb_typeof("task_launch_intents"."preparation_identity"->'worktreePath')='string' AND length("task_launch_intents"."preparation_identity"->>'worktreePath') BETWEEN 1 AND 4096
        AND ("task_launch_intents"."preparation_identity"->>'baseCommit' IS NOT DISTINCT FROM "task_launch_intents"."settings_snapshot"->>'baseCommit')
        AND "task_launch_intents"."preparation_identity"->>'inputDigest'="task_launch_intents"."input_digest" AND "task_launch_intents"."preparation_identity"->>'settingsDigest'="task_launch_intents"."settings_digest"
        AND ("task_launch_intents"."preparation_identity"->'version'='1'::jsonb AND "task_launch_intents"."settings_snapshot"->>'kind'='flow'
          AND jsonb_typeof("task_launch_intents"."preparation_identity"->'branch')='string' AND jsonb_typeof("task_launch_intents"."preparation_identity"->'parentRepoPath')='string'
          AND "task_launch_intents"."preparation_identity"->>'baseCommit' ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
          OR "task_launch_intents"."preparation_identity"->'version'='2'::jsonb AND "task_launch_intents"."preparation_identity"->>'kind'='agent' AND "task_launch_intents"."settings_snapshot"->>'kind'='agent'
          AND "task_launch_intents"."preparation_identity"->>'workspace'="task_launch_intents"."settings_snapshot"->>'workspace'
          AND jsonb_typeof("task_launch_intents"."preparation_identity"->'runtimePath')='string' AND length("task_launch_intents"."preparation_identity"->>'runtimePath') BETWEEN 1 AND 4096
          AND ("task_launch_intents"."preparation_identity"->>'workspace'='none' AND "task_launch_intents"."preparation_identity"->'parentRepoPath'='null'::jsonb AND "task_launch_intents"."preparation_identity"->'branch'='null'::jsonb AND "task_launch_intents"."preparation_identity"->'baseCommit'='null'::jsonb
            OR "task_launch_intents"."preparation_identity"->>'workspace' IN ('repo_read','worktree') AND jsonb_typeof("task_launch_intents"."preparation_identity"->'parentRepoPath')='string'
              AND "task_launch_intents"."preparation_identity"->>'baseCommit' ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
              AND ("task_launch_intents"."preparation_identity"->>'workspace'='repo_read' AND "task_launch_intents"."preparation_identity"->'branch'='null'::jsonb OR "task_launch_intents"."preparation_identity"->>'workspace'='worktree' AND jsonb_typeof("task_launch_intents"."preparation_identity"->'branch')='string')))
        AND "task_launch_intents"."preparation_phase" IN ('reserved','checkout_ready','materializing','materialized','run_bound') AND octet_length("task_launch_intents"."preparation_identity"::text)<=16384
      )) IS TRUE AND ("task_launch_intents"."cleanup_state" IS NULL OR "task_launch_intents"."cleanup_state" IN ('pending','removed','retained')));CREATE OR REPLACE FUNCTION guard_task_launch_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE phases text[]:=ARRAY['reserved','checkout_ready','materializing','materialized','run_bound'];
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.reservation_lane='concurrent' AND NOT (
      NEW.principal_kind='session_user' AND NEW.basis->>'kind'='manual'
      OR NEW.principal_kind='system' AND NEW.basis->>'kind'='automatic'
        AND NEW.settings_snapshot->'serverExecution'->>'kind'='evaluation'
        AND NEW.settings_snapshot->'serverExecution'->>'projectId'=NEW.project_id
        AND NEW.settings_snapshot->'serverExecution'->>'taskId'=NEW.task_id
        AND NEW.settings_snapshot->'serverExecution'->'execution'->>'evaluationBatchItemId'=NEW.settings_snapshot->'serverExecution'->>'id'
        AND EXISTS(SELECT 1 FROM evaluation_launch_batch_items item
          JOIN evaluation_launch_batches batch ON batch.id=item.batch_id
          JOIN evaluation_studies study ON study.id=batch.study_id
          WHERE item.id=NEW.settings_snapshot->'serverExecution'->>'id' AND item.status='launching'
            AND study.id=NEW.settings_snapshot->'serverExecution'->'execution'->>'evaluationStudyId'
            AND study.project_id=NEW.project_id AND study.task_id=NEW.task_id)
    ) IS TRUE THEN
      RAISE EXCEPTION 'Concurrent delivery requires its interactive decision or current controlled evaluation source'
        USING ERRCODE='23514',CONSTRAINT='task_launch_concurrent_authority';
    END IF;
    IF NEW.preparation_identity IS NOT NULL OR NEW.preparation_phase IS NOT NULL OR NEW.cleanup_state IS NOT NULL THEN
      RAISE EXCEPTION 'A new launch cannot fabricate preparation progress'
        USING ERRCODE='23514',CONSTRAINT='task_launch_preparation_initial';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.preparation_identity IS NOT NULL AND OLD.preparation_identity IS DISTINCT FROM NEW.preparation_identity THEN
    RAISE EXCEPTION 'Launch preparation identity is immutable'
      USING ERRCODE='23514',CONSTRAINT='task_launch_preparation_immutable';
  END IF;
  IF OLD.preparation_identity IS NULL AND NEW.preparation_identity IS NOT NULL THEN
    IF NEW.state<>'preparing' OR NEW.run_id IS NOT NULL OR NEW.preparation_phase<>'reserved'
      OR NEW.lease_expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'Preparation allocation requires a current unbound worker claim'
        USING ERRCODE='23514',CONSTRAINT='task_launch_preparation_owner';
    END IF;
  ELSIF OLD.preparation_phase IS DISTINCT FROM NEW.preparation_phase THEN
    IF OLD.state<>'preparing' OR OLD.lease_expires_at<=clock_timestamp()
      OR OLD.lease_token IS DISTINCT FROM NEW.lease_token AND NEW.state='preparing'
      OR (array_position(phases,NEW.preparation_phase)<>array_position(phases,OLD.preparation_phase)+1
        AND NOT (NEW.preparation_identity->'version'='2'::jsonb AND NEW.preparation_identity->>'kind'='agent' AND OLD.preparation_phase='reserved' AND NEW.preparation_phase='run_bound'))
      OR NEW.preparation_phase='run_bound' AND (NEW.state<>'run_bound' OR NEW.run_id IS DISTINCT FROM NEW.preparation_identity->>'runId') THEN
      RAISE EXCEPTION 'Preparation publication requires its current owner and next phase'
        USING ERRCODE='23514',CONSTRAINT='task_launch_preparation_owner';
    END IF;
  END IF;
  IF OLD.cleanup_state='removed' AND NEW.cleanup_state IS DISTINCT FROM OLD.cleanup_state
    OR OLD.cleanup_state IN ('pending','retained') AND NEW.cleanup_state IS NULL
    OR NEW.cleanup_state IS NOT NULL AND NEW.state NOT IN ('held','failed','cancelled','settled') THEN
    RAISE EXCEPTION 'Launch cleanup requires closed execution authority and cannot discard ownership or undo removal'
      USING ERRCODE='23514',CONSTRAINT='task_launch_preparation_cleanup';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_task_launch_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target tasks%ROWTYPE; assessment task_qualifications%ROWTYPE; slot jsonb; seen_slots text[]:=ARRAY[]::text[];
BEGIN
  IF current_setting('maister.task_launch_writer',true) IS DISTINCT FROM 'v3' THEN
    RAISE EXCEPTION 'Task launch writer v3 required; keep incompatible writers stopped under upgrade maintenance'
      USING ERRCODE='23514',CONSTRAINT='task_launch_writer_capability';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.cancellation_receipt IS NOT NULL AND OLD.cancellation_receipt IS DISTINCT FROM NEW.cancellation_receipt
      OR OLD.cancellation_receipt IS NULL AND NEW.cancellation_receipt IS NOT NULL AND NOT (
        OLD.state<>'cancelled' AND NEW.state='cancelled' AND NEW.cancellation_receipt->'expectedStateVersion'=to_jsonb(OLD.state_version)
      ) IS TRUE THEN
      RAISE EXCEPTION 'Cancellation receipt is immutable and must bind the accepted state version'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_cancellation_immutable';
    END IF;
    IF NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1
      OR NEW.attempts>OLD.attempts AND NOT (OLD.state='preparing' AND NEW.state IN ('queued','held','failed')) THEN
      RAISE EXCEPTION 'Preparation failure budget is monotonic and scoped to this launch'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_attempts_fenced';
    END IF;
    IF OLD.state='preparing' AND OLD.lease_expires_at<=clock_timestamp()
      AND NEW.state NOT IN ('held','cancelled') AND NOT (NEW.state='preparing' AND NEW.lease_token IS DISTINCT FROM OLD.lease_token) THEN
      RAISE EXCEPTION 'Expired launch worker must reacquire ownership before publication'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_lease_fenced';
    END IF;
    IF OLD.run_id IS NOT NULL AND NEW.run_id IS NULL AND OLD.state IN ('settled','cancelled','failed')
      AND ROW(NEW.state,NEW.reason,NEW.original_run_id,NEW.attempts,NEW.terminal_outcome,NEW.dispatch_committed_at)
        IS NOT DISTINCT FROM ROW(OLD.state,OLD.reason,OLD.original_run_id,OLD.attempts,OLD.terminal_outcome,OLD.dispatch_committed_at) THEN
      NEW.state_version:=OLD.state_version+1;
      NEW.updated_at:=clock_timestamp();
    END IF;
    IF ROW(OLD.id,OLD.schema_version,OLD.project_id,OLD.task_id,OLD.principal_kind,OLD.principal_id,OLD.actor_user_id,
        OLD.launch_source,OLD.operation,OLD.request_key,OLD.payload_digest,OLD.task_revision,OLD.input_revision,
        OLD.input_digest,OLD.input_snapshot,OLD.settings_digest,OLD.settings_snapshot,OLD.basis,OLD.reservation_lane,
        OLD.replaces_intent_id,OLD.source_run_id,OLD.accepted_at)
      IS DISTINCT FROM ROW(NEW.id,NEW.schema_version,NEW.project_id,NEW.task_id,NEW.principal_kind,NEW.principal_id,NEW.actor_user_id,
        NEW.launch_source,NEW.operation,NEW.request_key,NEW.payload_digest,NEW.task_revision,NEW.input_revision,
        NEW.input_digest,NEW.input_snapshot,NEW.settings_digest,NEW.settings_snapshot,NEW.basis,NEW.reservation_lane,
        NEW.replaces_intent_id,NEW.source_run_id,NEW.accepted_at)
      OR OLD.original_run_id IS NOT NULL AND OLD.original_run_id IS DISTINCT FROM NEW.original_run_id
      OR OLD.dispatch_committed_at IS NOT NULL AND OLD.dispatch_committed_at IS DISTINCT FROM NEW.dispatch_committed_at THEN
      RAISE EXCEPTION 'Accepted task launch request is immutable'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_request_immutable';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      OLD.state='queued' AND NEW.state IN ('preparing','held','cancelled') OR
      OLD.state IN ('queued','preparing') AND NEW.state='settled' AND NEW.run_id IS NOT NULL AND EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND status=NEW.terminal_outcome) OR
      OLD.state='preparing' AND NEW.state IN ('queued','run_bound','held','cancelled','failed') OR
      OLD.state='held' AND (NEW.state IN ('queued','cancelled') OR NEW.state='settled' AND NEW.run_id IS NOT NULL AND EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND status=NEW.terminal_outcome)) OR
      OLD.state='run_bound' AND (NEW.state IN ('held','cancelled','settled') OR NEW.state='queued'
        AND NEW.reason='launch_capacity_wait' AND OLD.dispatch_committed_at IS NULL AND NEW.run_id=OLD.run_id
        AND NEW.preparation_identity IS NOT NULL AND EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND status='Pending')
        AND NOT EXISTS(SELECT 1 FROM execution_commands WHERE run_id=NEW.run_id AND kind IN ('session.create','session.prompt'))) OR
      OLD.state='settled' AND NEW.state='run_bound' AND OLD.terminal_outcome='Crashed' AND NEW.run_id=OLD.run_id
    ) THEN
      RAISE EXCEPTION 'Task launch state transition is not allowed'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_transition_check';
    END IF;
    IF OLD.dispatch_committed_at IS NOT NULL AND NEW.state IN ('held','cancelled') THEN
      RAISE EXCEPTION 'Execution already committed; use Stop for this run'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_dispatch_committed';
    END IF;
    IF ROW(NEW.state,NEW.reason,NEW.run_id,NEW.original_run_id,NEW.attempts,NEW.terminal_outcome,NEW.dispatch_committed_at)
      IS DISTINCT FROM ROW(OLD.state,OLD.reason,OLD.run_id,OLD.original_run_id,OLD.attempts,OLD.terminal_outcome,OLD.dispatch_committed_at) THEN
      IF NEW.state_version<>OLD.state_version+1 THEN
        RAISE EXCEPTION 'Task launch transition requires the next state version'
          USING ERRCODE='23514',CONSTRAINT='task_launch_intents_state_version';
      END IF;
    ELSIF NEW.state_version<>OLD.state_version THEN
      RAISE EXCEPTION 'Lease renewal cannot invent a task launch transition'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_state_version';
    END IF;
  ELSE
    IF NEW.input_snapshot->'version' IS DISTINCT FROM '2'::jsonb
      OR NEW.settings_snapshot->'version' IS DISTINCT FROM '2'::jsonb
      OR NOT (jsonb_typeof(NEW.settings_snapshot->'capabilityResolutionDigest')='string' AND NEW.settings_snapshot->>'capabilityResolutionDigest' ~ '^[0-9a-f]{64}$') IS TRUE
      OR NOT NEW.settings_snapshot ? 'resolvedCapabilitySet'
      OR NOT (NEW.settings_snapshot->>'kind'='flow' AND NEW.settings_snapshot->'resolvedCapabilitySet'->>'flowRevisionId'=NEW.settings_snapshot->>'flowRevisionId'
        AND jsonb_typeof(NEW.settings_snapshot->'resolvedCapabilitySet'->'capabilities')='array'
        AND jsonb_typeof(NEW.settings_snapshot->'resolvedCapabilitySet'->'mcps')='array'
        OR NEW.settings_snapshot->>'kind'='agent' AND NEW.settings_snapshot->'resolvedCapabilitySet'='null'::jsonb) IS TRUE THEN
      RAISE EXCEPTION 'New launches require complete version 2 execution snapshots'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_execution_input_required';
    END IF;
    IF NOT (jsonb_typeof(NEW.input_snapshot->'clarifications')='array'
      AND jsonb_array_length(NEW.input_snapshot->'clarifications')<=20) IS TRUE THEN
      RAISE EXCEPTION 'Execution clarification projection exceeds its bound'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_execution_input_required';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.input_snapshot->'clarifications') entry(value)
      LEFT JOIN task_clarifications clarification ON clarification.id=entry.value->>'id' AND clarification.task_id=NEW.task_id
      WHERE clarification.id IS NULL OR entry.value->'seq' IS DISTINCT FROM to_jsonb(clarification.seq)
        OR clarification.answered_at IS NULL OR clarification.superseded_at IS NOT NULL
        OR clarification.answer IS DISTINCT FROM entry.value->'answer'
        OR NOT (jsonb_typeof(entry.value->'question')='string' AND starts_with(clarification.question,entry.value->>'question')) IS TRUE)
      OR coalesce((SELECT jsonb_agg(entry.value->>'id') FROM jsonb_array_elements(NEW.input_snapshot->'clarifications') entry(value)),'[]'::jsonb)
        IS DISTINCT FROM coalesce((SELECT jsonb_agg(clarification.id ORDER BY clarification.seq,clarification.id)
          FROM (SELECT id,seq FROM task_clarifications WHERE task_id=NEW.task_id AND answered_at IS NOT NULL
            AND superseded_at IS NULL AND answer IS NOT NULL AND answer<>'null'::jsonb ORDER BY seq,id LIMIT 20) clarification),'[]'::jsonb) THEN
      RAISE EXCEPTION 'Execution clarification projection must freeze the current task context'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_execution_input_required';
    END IF;
    IF NOT (
      NEW.input_snapshot ?& ARRAY['version','projectId','taskId','number','title','prompt','statementRevision','sourceVersion','target','deliveryTarget','clarifications']
      AND NEW.settings_snapshot ?& ARRAY['version','kind','workspace','agentId','definitionSha256','flowId','flowRefId','flowRevisionId','packageInstallId','sessions','baseBranch','baseCommit','targetBranch','promotionMode','autoPromote','deliveryPolicy','executionPolicy','taskSettingsDigest','resolutionToken']
      AND jsonb_typeof(NEW.input_snapshot->'number')='number' AND (NEW.input_snapshot->>'number')::numeric>0
      AND jsonb_typeof(NEW.input_snapshot->'target')='string' AND length(NEW.input_snapshot->>'target') BETWEEN 1 AND 256
      AND jsonb_typeof(NEW.input_snapshot->'deliveryTarget')='string' AND length(NEW.input_snapshot->>'deliveryTarget') BETWEEN 1 AND 256
      AND (NEW.settings_snapshot->>'kind'='flow' AND NEW.settings_snapshot->>'workspace'='worktree' AND length(NEW.settings_snapshot->>'flowId') BETWEEN 1 AND 256
        AND length(NEW.settings_snapshot->>'flowRefId') BETWEEN 1 AND 256
        AND length(NEW.settings_snapshot->>'flowRevisionId') BETWEEN 1 AND 256
        OR NEW.settings_snapshot->>'kind'='agent' AND NEW.settings_snapshot->>'workspace' IN ('none','repo_read','worktree') AND length(NEW.settings_snapshot->>'agentId') BETWEEN 1 AND 256
        AND NEW.settings_snapshot->>'definitionSha256' ~ '^[0-9a-f]{64}$')
      AND length(NEW.settings_snapshot->>'baseBranch') BETWEEN 1 AND 256
      AND length(NEW.settings_snapshot->>'targetBranch') BETWEEN 1 AND 256
      AND NEW.settings_snapshot->>'promotionMode' IN ('local_merge','rebase_merge','pull_request')
      AND NEW.settings_snapshot->>'taskSettingsDigest' ~ '^[0-9a-f]{64}$'
      AND NEW.settings_snapshot->>'resolutionToken' ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(NEW.settings_snapshot->'sessions')='array'
    ) IS TRUE THEN
      RAISE EXCEPTION 'Task launch snapshots are incomplete or malformed'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_snapshot_check';
    END IF;
    FOR slot IN SELECT value FROM jsonb_array_elements(NEW.settings_snapshot->'sessions') LOOP
      IF NOT (jsonb_typeof(slot)='object' AND slot ?& ARRAY['sessionName','runnerId','runnerSnapshot','runnerConfigDigest']
        AND jsonb_typeof(slot->'sessionName')='string' AND length(slot->>'sessionName') BETWEEN 1 AND 256
        AND jsonb_typeof(slot->'runnerId')='string' AND length(slot->>'runnerId') BETWEEN 1 AND 256
        AND jsonb_typeof(slot->'runnerSnapshot')='object' AND slot->'runnerSnapshot'->>'id'=slot->>'runnerId'
        AND NOT slot->'runnerSnapshot' ?| ARRAY['env','provider']
        AND slot->>'runnerConfigDigest' ~ '^[0-9a-f]{64}$'
        AND NOT slot->>'sessionName'=ANY(seen_slots)) IS TRUE THEN
        RAISE EXCEPTION 'Task launch runner metadata must be unique, bounded and credential-free'
          USING ERRCODE='23514',CONSTRAINT='task_launch_intents_snapshot_check';
      END IF;
      seen_slots:=array_append(seen_slots,slot->>'sessionName');
    END LOOP;
    SELECT * INTO target FROM tasks WHERE id=NEW.task_id AND project_id=NEW.project_id FOR SHARE;
    IF NOT FOUND OR target.revision<>NEW.task_revision OR target.qualification_input_revision<>NEW.input_revision
      OR target.title IS DISTINCT FROM NEW.input_snapshot->>'title' OR target.prompt IS DISTINCT FROM NEW.input_snapshot->>'prompt' THEN
      RAISE EXCEPTION 'Task launch must freeze the current task input'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_input_current';
    END IF;
    IF NEW.state<>'queued' OR NEW.run_id IS NOT NULL OR NEW.original_run_id IS NOT NULL OR NEW.state_version<>1
      OR NEW.dispatch_committed_at IS NOT NULL OR NEW.attempts<>0 THEN
      RAISE EXCEPTION 'A new launch starts queued without execution authority'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_initial_state';
    END IF;
    IF NEW.basis->>'kind'='automatic' THEN
      SELECT * INTO assessment FROM task_qualifications WHERE id=NEW.basis->>'qualificationId'
        AND project_id=NEW.project_id AND task_id=NEW.task_id;
      IF NOT FOUND OR assessment.publication_state<>'accepted' OR assessment.value->>'decision'<>'ready'
        OR assessment.input_revision<>target.qualification_input_revision OR assessment.input_digest IS DISTINCT FROM NEW.basis->>'qualificationInputDigest'
        OR assessment.id IS DISTINCT FROM target.current_qualification_id OR assessment.revision IS DISTINCT FROM target.current_qualification_revision
        OR to_jsonb(assessment.revision) IS DISTINCT FROM NEW.basis->'qualificationRevision'
        OR assessment.evidence_target IS DISTINCT FROM NEW.basis->>'evidenceTarget'
        OR assessment.evidence_sha IS DISTINCT FROM NEW.basis->>'evidenceSha'
        OR NEW.settings_snapshot->>'workspace'<>'none' AND assessment.evidence_sha IS DISTINCT FROM NEW.settings_snapshot->>'baseCommit' THEN
        RAISE EXCEPTION 'Automatic task launch requires current accepted qualification'
          USING ERRCODE='23514',CONSTRAINT='task_launch_intents_automatic_admission';
      END IF;
    END IF;
    IF NEW.basis->>'kind'='execution_child' AND NOT (
      target.qualification_mode='execution_child' AND target.qualification_child_proof=NEW.basis->'parent'
      AND EXISTS(SELECT 1 FROM runs parent WHERE parent.id=NEW.basis->'parent'->>'parentRunId'
        AND parent.project_id=NEW.project_id AND parent.agent_kind IS DISTINCT FROM 'operational'
        AND parent.status IN ('Running','NeedsInput','NeedsInputIdle','HumanWorking','WaitingOnChildren','Review')
        AND parent.task_id IS NOT DISTINCT FROM NEW.basis->'parent'->>'parentTaskId')
    ) IS TRUE THEN
      RAISE EXCEPTION 'Execution child launch requires its live admitted parent proof'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_parent_admission';
    END IF;
  END IF;
  IF NEW.state='preparing' AND NOT (length(NEW.lease_token) BETWEEN 1 AND 256
      AND NEW.lease_expires_at>clock_timestamp() AND NEW.lease_expires_at<=clock_timestamp()+interval '61 seconds') IS TRUE THEN
    RAISE EXCEPTION 'Preparing launch requires a bounded current owner lease'
      USING ERRCODE='23514',CONSTRAINT='task_launch_intents_lease_required';
  END IF;
  IF NEW.run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND task_id=NEW.task_id
      AND project_id=NEW.project_id AND task_launch_intent_id=NEW.id) THEN
    RAISE EXCEPTION 'Task launch run binding does not match its request'
      USING ERRCODE='23514',CONSTRAINT='task_launch_intents_run_binding';
  END IF;
  IF NEW.state='settled' AND NEW.run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND status=NEW.terminal_outcome)
      OR NEW.state='cancelled' AND NEW.run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND status='Abandoned') THEN
    RAISE EXCEPTION 'Bound launch settlement requires its terminal run transition'
      USING ERRCODE='23514',CONSTRAINT='task_launch_intents_terminal_binding';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_task_launch_dispatch_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent task_launch_intents%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' AND NEW.task_launch_intent_id IS NOT NULL AND NEW.status<>'Pending' THEN
    RAISE EXCEPTION 'Accepted task runs start Pending before first dispatch'
      USING ERRCODE='23514',CONSTRAINT='task_launch_initial_pending';
  END IF;
  IF TG_OP='INSERT' OR NEW.status IN ('Running','NeedsInput','HumanWorking') AND OLD.status NOT IN ('Running','NeedsInput','HumanWorking') THEN
    IF current_setting('maister.task_launch_writer',true) IS DISTINCT FROM 'v3' THEN
      RAISE EXCEPTION 'Task launch writer v3 required for capacity-aware admission; keep older writers stopped during upgrade'
        USING ERRCODE='23514',CONSTRAINT='task_launch_writer_capability';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='Pending' AND NEW.status='Running' AND NEW.task_launch_intent_id IS NOT NULL THEN
    SELECT * INTO intent FROM task_launch_intents WHERE id=NEW.task_launch_intent_id;
    IF NOT FOUND OR intent.state<>'run_bound' OR intent.run_id<>NEW.id
      OR (NEW.run_kind<>'agent' AND (intent.dispatch_committed_at IS NULL OR NEW.task_admission_checked_at IS NULL)) THEN
      RAISE EXCEPTION 'Accepted task dispatch must commit its current immutable authority before execution'
        USING ERRCODE='23514',CONSTRAINT='task_launch_dispatch_commit_required';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_task_launch_dispatch_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
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
          AND NEW.dispatch_receipt-ARRAY['version','runId','assignmentId','assignmentEpoch','inputDigest','settingsDigest','committedAt','preparation']='{}'::jsonb
          AND (NEW.settings_snapshot->>'kind'='flow' AND NOT NEW.dispatch_receipt ? 'preparation'
            OR NEW.settings_snapshot->>'kind'='agent' AND jsonb_typeof(NEW.dispatch_receipt->'preparation')='object'
              AND NEW.dispatch_receipt->'preparation'->>'baselineDigest' ~ '^[0-9a-f]{64}$'
              AND NEW.dispatch_receipt->'preparation'->>'materializationDigest' ~ '^[0-9a-f]{64}$'
              AND EXISTS(SELECT 1 FROM agent_preparation_operations preparation JOIN runs prepared_run ON prepared_run.id=preparation.run_id
                WHERE preparation.id=NEW.dispatch_receipt->'preparation'->>'id' AND preparation.run_id=NEW.run_id
                  AND preparation.assignment_id=NEW.dispatch_receipt->>'assignmentId' AND to_jsonb(preparation.assignment_epoch)=NEW.dispatch_receipt->'assignmentEpoch'
                  AND preparation.phase='materialized' AND preparation.lease_expires_at>clock_timestamp()
                  AND preparation.resource_id=NEW.dispatch_receipt->'preparation'->>'resourceId'
                  AND preparation.incarnation=NEW.dispatch_receipt->'preparation'->>'incarnation'
                  AND to_jsonb(preparation.generation)=NEW.dispatch_receipt->'preparation'->'generation'
                  AND prepared_run.operational_integrity_baseline->'generation'=to_jsonb(preparation.generation)))
          AND octet_length(NEW.dispatch_receipt::text)<=8192
          AND EXISTS(SELECT 1 FROM execution_assignments assignment
            WHERE assignment.id=NEW.dispatch_receipt->>'assignmentId' AND assignment.run_id=NEW.run_id
              AND assignment.state='active' AND to_jsonb(assignment.epoch)=NEW.dispatch_receipt->'assignmentEpoch'
              AND EXISTS(SELECT 1 FROM runs owner_run WHERE owner_run.id=NEW.run_id AND owner_run.execution_assignment_id=assignment.id))
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
CREATE OR REPLACE FUNCTION guard_task_launch_continuation_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_launch_intent_id IS NOT NULL AND NEW.status IN ('Running','NeedsInput','HumanWorking')
    AND OLD.status NOT IN ('Running','NeedsInput','HumanWorking') AND NOT EXISTS(
      SELECT 1 FROM task_launch_intents intent WHERE intent.id=NEW.task_launch_intent_id
        AND intent.run_id=NEW.id AND intent.state='run_bound' AND (intent.dispatch_receipt IS NOT NULL OR OLD.status='Pending' AND NEW.run_kind='agent' AND intent.preparation_identity->'version'='2'::jsonb AND intent.settings_snapshot->>'kind'='agent')
    ) THEN
    RAISE EXCEPTION 'Execution continuation must reacquire its original launch reservation'
      USING ERRCODE='23514',CONSTRAINT='task_launch_continuation_reservation';
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_run_task_launch_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent task_launch_intents%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND OLD.task_launch_intent_id IS DISTINCT FROM NEW.task_launch_intent_id THEN
    RAISE EXCEPTION 'Run launch authority is write-once'
      USING ERRCODE='23514',CONSTRAINT='runs_task_launch_binding_immutable';
  END IF;
  IF NEW.task_launch_intent_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO intent FROM task_launch_intents WHERE id=NEW.task_launch_intent_id FOR SHARE;
  IF current_setting('maister.task_launch_writer',true) IS DISTINCT FROM 'v3' OR NOT FOUND
    OR intent.project_id IS DISTINCT FROM NEW.project_id OR intent.task_id IS DISTINCT FROM NEW.task_id
    OR intent.input_snapshot->'version' IS DISTINCT FROM '2'::jsonb
    OR intent.settings_snapshot->'version' IS DISTINCT FROM '2'::jsonb
    OR NEW.resolved_capability_set IS DISTINCT FROM nullif(intent.settings_snapshot->'resolvedCapabilitySet','null'::jsonb)
    OR intent.state<>'preparing' OR intent.lease_expires_at<=clock_timestamp()
    OR NEW.task_admission_snapshot->>'intentId' IS DISTINCT FROM intent.id
    OR NEW.task_admission_snapshot->>'basis' IS DISTINCT FROM intent.basis->>'kind'
    OR NEW.task_admission_snapshot->'inputRevision' IS DISTINCT FROM to_jsonb(intent.input_revision)
    OR NEW.task_admission_snapshot->>'evidenceSha' IS DISTINCT FROM (CASE WHEN intent.basis->>'kind'='automatic' THEN intent.basis->>'evidenceSha' ELSE intent.settings_snapshot->>'baseCommit' END)
    OR NEW.task_admission_snapshot->>'evidenceTarget' IS DISTINCT FROM (CASE WHEN intent.basis->>'kind'='automatic' THEN intent.basis->>'evidenceTarget' ELSE intent.settings_snapshot->>'baseBranch' END)
    OR intent.original_run_id IS NOT NULL AND intent.original_run_id<>NEW.id THEN
    RAISE EXCEPTION 'Run requires its claimed matching launch intent'
      USING ERRCODE='23514',CONSTRAINT='runs_task_launch_binding_required';
  END IF;
  IF intent.basis->>'kind'='automatic' AND (
    NEW.task_admission_snapshot->>'qualificationId' IS DISTINCT FROM intent.basis->>'qualificationId'
    OR NEW.task_admission_snapshot->'qualificationRevision' IS DISTINCT FROM intent.basis->'qualificationRevision'
    OR NOT EXISTS(SELECT 1 FROM tasks WHERE id=NEW.task_id AND current_qualification_id=intent.basis->>'qualificationId'
      AND to_jsonb(current_qualification_revision)=intent.basis->'qualificationRevision' AND qualification_input_revision=intent.input_revision)
  ) OR intent.basis->>'kind'='execution_child' AND NEW.task_admission_snapshot->'parent' IS DISTINCT FROM intent.basis->'parent' THEN
    RAISE EXCEPTION 'Run admission differs from its accepted qualification or parent'
      USING ERRCODE='23514',CONSTRAINT='runs_task_launch_basis_required';
  END IF;
  IF NEW.run_kind IS DISTINCT FROM intent.settings_snapshot->>'kind'
    OR NEW.agent_kind='operational' OR NEW.execution_policy IS DISTINCT FROM intent.settings_snapshot->'executionPolicy'
    OR (NEW.run_kind='flow' AND (NEW.flow_id IS DISTINCT FROM intent.settings_snapshot->>'flowId'
      OR NEW.flow_revision_id IS DISTINCT FROM intent.settings_snapshot->>'flowRevisionId'))
    OR (NEW.run_kind='agent' AND (NEW.agent_workspace IS DISTINCT FROM intent.settings_snapshot->>'workspace' OR NEW.agent_id IS DISTINCT FROM intent.settings_snapshot->>'agentId'
      OR NEW.agent_activity_snapshot->>'definitionSha256' IS DISTINCT FROM intent.settings_snapshot->>'definitionSha256')) THEN
    RAISE EXCEPTION 'Run target and execution policy must match the frozen launch settings'
      USING ERRCODE='23514',CONSTRAINT='runs_task_launch_settings_required';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION task_launch_canonical_admission(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{'||coalesce(string_agg(to_jsonb(entry.key)::text||':'||task_launch_canonical_admission(entry.value),',' ORDER BY entry.key COLLATE "C"),'')||'}'
        INTO result FROM jsonb_each(value) entry;
    WHEN 'array' THEN
      SELECT '['||coalesce(string_agg(task_launch_canonical_admission(entry.value),',' ORDER BY entry.ordinality),'')||']'
        INTO result FROM jsonb_array_elements(value) WITH ORDINALITY entry(value,ordinality);
    ELSE RETURN value::text;
  END CASE;
  RETURN result;
END $$;
--> statement-breakpoint
CREATE FUNCTION task_launch_admission_digest(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT encode(sha256(convert_to(task_launch_canonical_admission(value),'UTF8')),'hex')
$$;
--> statement-breakpoint
CREATE FUNCTION assert_task_consensus_child_scope(candidate runs) RETURNS void LANGUAGE plpgsql AS $$
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
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_consensus_child_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_admission_snapshot->'version'='3'::jsonb AND OLD.task_admission_snapshot->'version' IS DISTINCT FROM '3'::jsonb THEN
    RAISE EXCEPTION 'Consensus child admission is established only at creation'
      USING ERRCODE='23514',CONSTRAINT='runs_consensus_admission_immutable';
  END IF;
  IF OLD.task_admission_snapshot->'version'='3'::jsonb AND (
    OLD.task_admission_snapshot IS DISTINCT FROM NEW.task_admission_snapshot
    OR (OLD.project_id,OLD.task_id,OLD.parent_run_id,OLD.root_run_id,OLD.run_kind,OLD.agent_id,OLD.agent_workspace,OLD.persistent,OLD.workspace_mode,OLD.trigger_payload)
      IS DISTINCT FROM (NEW.project_id,NEW.task_id,NEW.parent_run_id,NEW.root_run_id,NEW.run_kind,NEW.agent_id,NEW.agent_workspace,NEW.persistent,NEW.workspace_mode,NEW.trigger_payload)) THEN
    RAISE EXCEPTION 'Consensus child admission and source are immutable'
      USING ERRCODE='23514',CONSTRAINT='runs_consensus_admission_immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER runs_consensus_receipt_immutable BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION guard_consensus_child_receipt_immutable();
--> statement-breakpoint
CREATE FUNCTION guard_consensus_child_runner_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE child runs%ROWTYPE;
BEGIN
  SELECT * INTO child FROM runs WHERE id=NEW.run_id;
  IF child.task_admission_snapshot->'version'='3'::jsonb AND (NEW.session_name<>'default' OR NEW.runner_id IS DISTINCT FROM child.task_admission_snapshot->'parent'->>'runnerId') THEN
    RAISE EXCEPTION 'Consensus child session must use its approved participant runner'
      USING ERRCODE='23514',CONSTRAINT='run_sessions_consensus_runner_binding';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER run_sessions_consensus_binding BEFORE INSERT OR UPDATE OF runner_id,session_name ON run_sessions FOR EACH ROW EXECUTE FUNCTION guard_consensus_child_runner_binding();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_new_task_delivery_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target tasks%ROWTYPE;
BEGIN
  IF NEW.task_admission_snapshot ? 'carrier' THEN
    PERFORM assert_taskless_agent_carrier_scope(NEW);
    RETURN NEW;
  END IF;
  IF NEW.task_admission_snapshot->'version'='3'::jsonb THEN
    PERFORM assert_task_consensus_child_scope(NEW);
    RETURN NEW;
  END IF;
  IF NEW.task_launch_intent_id IS NOT NULL THEN
    -- The intent binding guard validates stored basis, input, lease and scope.
    -- v1 remains byte-compatible until the coordinated v2 writer cutover.
    RETURN NEW;
  END IF;
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
CREATE OR REPLACE FUNCTION guard_task_launch_shared_reservation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'runs' THEN
    IF NEW.task_id IS NULL OR NEW.run_kind NOT IN ('flow', 'agent')
      OR NEW.agent_kind = 'operational' OR NEW.task_launch_intent_id IS NOT NULL
      OR NEW.status NOT IN ('Pending', 'Running', 'NeedsInput', 'NeedsInputIdle', 'HumanWorking', 'WaitingOnChildren') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
      -- Same-run continuation keeps its historical receipt and reservation.
      -- Re-entering after release must compete with a newly accepted request.
      IF OLD.task_id IS NOT DISTINCT FROM NEW.task_id
        AND OLD.run_kind IN ('flow', 'agent')
        AND OLD.agent_kind IS DISTINCT FROM 'operational'
        AND OLD.task_launch_intent_id IS NULL
        AND OLD.status IN ('Pending', 'Running', 'NeedsInput', 'NeedsInputIdle', 'HumanWorking', 'WaitingOnChildren') THEN
        RETURN NEW;
      END IF;
    END IF;

    IF NEW.task_admission_snapshot->'version'='3'::jsonb THEN
      PERFORM assert_task_consensus_child_scope(NEW);
      RETURN NEW;
    END IF;

    PERFORM id FROM tasks WHERE id = NEW.task_id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM task_launch_intents
      WHERE task_id = NEW.task_id
        AND state IN ('queued', 'preparing', 'run_bound', 'held')
    ) THEN
      RAISE EXCEPTION 'Task delivery is already reserved by an accepted launch request'
        USING ERRCODE = '23514', CONSTRAINT = 'task_launch_shared_reservation';
    END IF;
  ELSE
    IF NEW.reservation_lane <> 'ordinary'
      OR NEW.state NOT IN ('queued', 'preparing', 'run_bound', 'held') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
      IF OLD.task_id IS NOT DISTINCT FROM NEW.task_id
        AND OLD.reservation_lane = 'ordinary'
        AND OLD.state IN ('queued', 'preparing', 'run_bound', 'held') THEN
        RETURN NEW;
      END IF;
    END IF;

    PERFORM id FROM tasks WHERE id = NEW.task_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM task_launch_intents WHERE task_id=NEW.task_id AND id<>NEW.id
      AND state IN ('queued','preparing','run_bound','held')) THEN
      RAISE EXCEPTION 'Ordinary delivery waits for the existing explicit delivery request'
        USING ERRCODE='23514',CONSTRAINT='task_launch_shared_reservation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM runs
      WHERE task_id = NEW.task_id AND task_launch_intent_id IS NULL
        AND run_kind IN ('flow', 'agent') AND agent_kind IS DISTINCT FROM 'operational'
        AND (task_admission_snapshot->'version'='3'::jsonb AND task_admission_snapshot->>'mode'='execution_child'
          AND task_admission_snapshot->>'scope'='consensus_draft') IS DISTINCT FROM TRUE
        AND status IN ('Pending', 'Running', 'NeedsInput', 'NeedsInputIdle', 'HumanWorking', 'WaitingOnChildren')
    ) THEN
      RAISE EXCEPTION 'Task delivery is already reserved by a historical admission run'
        USING ERRCODE = '23514', CONSTRAINT = 'task_launch_shared_reservation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
CREATE FUNCTION assert_taskless_agent_carrier_scope(candidate runs) RETURNS void LANGUAGE plpgsql AS $$
DECLARE target tasks%ROWTYPE; witness jsonb:=candidate.task_admission_snapshot->'carrier'; frozen jsonb:=witness->'inputSnapshot';
BEGIN
  SELECT * INTO target FROM tasks WHERE id=candidate.task_id AND project_id=candidate.project_id FOR SHARE;
  IF NOT FOUND OR candidate.run_kind<>'flow' OR candidate.agent_id IS NULL OR candidate.task_launch_intent_id IS NOT NULL
    OR candidate.created_by_user_id IS NOT NULL OR candidate.parent_run_id IS NOT NULL
    OR target.created_by_user_id IS NOT NULL OR target.revision<>0 OR target.attempt_number<>1
    OR target.agent_id IS DISTINCT FROM candidate.agent_id OR target.flow_id IS DISTINCT FROM candidate.flow_id
    OR target.trigger_event_id IS DISTINCT FROM candidate.trigger_event_id
    OR candidate.task_admission_snapshot->>'mode' IS DISTINCT FROM 'legacy'
    OR witness->>'agentId' IS DISTINCT FROM candidate.agent_id
    OR NOT (witness->>'metadataDigest' ~ '^[a-f0-9]{64}$') IS TRUE
    OR witness-ARRAY['inputSnapshot','inputDigest','agentId','metadataDigest']<>'{}'::jsonb
    OR jsonb_typeof(frozen) IS DISTINCT FROM 'object' OR frozen->'version' IS DISTINCT FROM '2'::jsonb
    OR frozen->>'projectId' IS DISTINCT FROM candidate.project_id OR frozen->>'taskId' IS DISTINCT FROM candidate.task_id
    OR frozen->>'title' IS DISTINCT FROM target.title OR frozen->>'prompt' IS DISTINCT FROM target.prompt
    OR frozen->'statementRevision' IS DISTINCT FROM coalesce(to_jsonb(target.statement_revision),'null'::jsonb)
    OR jsonb_typeof(frozen->'clarifications') IS DISTINCT FROM 'array' OR jsonb_array_length(frozen->'clarifications')<>0
    OR task_launch_admission_digest(frozen) IS DISTINCT FROM witness->>'inputDigest'
    OR candidate.task_admission_snapshot->'inputRevision' IS DISTINCT FROM to_jsonb(target.qualification_input_revision)
    OR EXISTS(SELECT 1 FROM runs WHERE task_id=candidate.task_id)
    OR EXISTS(SELECT 1 FROM task_launch_intents WHERE task_id=candidate.task_id) THEN
    RAISE EXCEPTION 'Taskless agent carrier requires its one fresh generated input'
      USING ERRCODE='23514',CONSTRAINT='runs_taskless_agent_carrier_scope';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_taskless_agent_carrier_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_admission_snapshot ? 'carrier' AND NOT coalesce(OLD.task_admission_snapshot ? 'carrier',false) THEN
    RAISE EXCEPTION 'Taskless carrier admission is established only at creation'
      USING ERRCODE='23514',CONSTRAINT='runs_taskless_carrier_admission_immutable';
  END IF;
  IF OLD.task_admission_snapshot ? 'carrier' AND (
    OLD.task_admission_snapshot IS DISTINCT FROM NEW.task_admission_snapshot
    OR (OLD.project_id,OLD.task_id,OLD.agent_id,OLD.flow_id,OLD.created_by_user_id,OLD.trigger_event_id,OLD.parent_run_id)
      IS DISTINCT FROM (NEW.project_id,NEW.task_id,NEW.agent_id,NEW.flow_id,NEW.created_by_user_id,NEW.trigger_event_id,NEW.parent_run_id)) THEN
    RAISE EXCEPTION 'Taskless carrier admission and source are immutable'
      USING ERRCODE='23514',CONSTRAINT='runs_taskless_carrier_admission_immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER runs_taskless_agent_carrier_immutable BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION guard_taskless_agent_carrier_immutable();
--> statement-breakpoint
CREATE FUNCTION lock_consensus_draft_command_admission(child_run_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE child runs%ROWTYPE;
BEGIN
  SELECT * INTO child FROM runs WHERE id=child_run_id;
  IF child.task_admission_snapshot->'version' IS DISTINCT FROM '3'::jsonb THEN RETURN; END IF;
  PERFORM id FROM runs WHERE id=child.parent_run_id FOR UPDATE;
  PERFORM id FROM node_attempts WHERE id=child.task_admission_snapshot->'parent'->>'nodeAttemptId' FOR UPDATE;
  SELECT * INTO child FROM runs WHERE id=child_run_id FOR UPDATE;
  PERFORM assert_task_consensus_child_scope(child);
  IF child.status NOT IN ('Running','NeedsInput','NeedsInputIdle') THEN
    RAISE EXCEPTION 'Consensus child command requires its current active execution'
      USING ERRCODE='23514',CONSTRAINT='execution_commands_consensus_child_admission';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_consensus_child_command_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE child runs%ROWTYPE; assignment execution_assignments%ROWTYPE;
BEGIN
  IF NEW.kind NOT IN ('session.create','session.prompt') OR NEW.state NOT IN ('queued','delivering') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.state=OLD.state AND NEW.attempts=OLD.attempts AND NEW.max_attempts=OLD.max_attempts THEN RETURN NEW; END IF;
  SELECT * INTO child FROM runs WHERE id=NEW.run_id;
  IF child.task_admission_snapshot->'version' IS DISTINCT FROM '3'::jsonb THEN RETURN NEW; END IF;
  PERFORM lock_consensus_draft_command_admission(child.id);
  SELECT * INTO child FROM runs WHERE id=NEW.run_id;
  SELECT * INTO assignment FROM execution_assignments WHERE id=NEW.execution_assignment_id FOR SHARE;
  IF assignment.id IS NULL OR assignment.state<>'active' OR child.execution_assignment_id IS DISTINCT FROM assignment.id
    OR assignment.run_id IS DISTINCT FROM child.id OR assignment.epoch<>NEW.assignment_epoch OR assignment.execution_host_id IS DISTINCT FROM NEW.execution_host_id THEN
    RAISE EXCEPTION 'Consensus child command requires its current assignment epoch'
      USING ERRCODE='23514',CONSTRAINT='execution_commands_consensus_assignment_admission';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER execution_commands_00_consensus_admission BEFORE INSERT OR UPDATE OF state,attempts,max_attempts ON execution_commands
  FOR EACH ROW EXECUTE FUNCTION guard_consensus_child_command_admission();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_agent_trigger_attempt_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.project_id, NEW.source_agent_id, NEW.schedule_id, NEW.binding_snapshot,
         NEW.fence, NEW.delivery_key, NEW.trigger_source, NEW.trigger_event_id,
         NEW.provenance, NEW.reserved_run_id, NEW.claimed_at, NEW.scheduled_request_snapshot)
     IS DISTINCT FROM
     ROW(OLD.project_id, OLD.source_agent_id, OLD.schedule_id, OLD.binding_snapshot,
         OLD.fence, OLD.delivery_key, OLD.trigger_source, OLD.trigger_event_id,
         OLD.provenance, OLD.reserved_run_id, OLD.claimed_at, OLD.scheduled_request_snapshot) THEN
    RAISE EXCEPTION 'agent trigger attempt identity is immutable for %', OLD.id
      USING ERRCODE='23514', CONSTRAINT='agent_trigger_attempt_identity_immutable';
  END IF;
  IF OLD.outcome IS NOT NULL AND OLD.outcome <> 'unknown' AND
     ROW(NEW.outcome, NEW.settled_at, NEW.original_run_id, NEW.reason_code)
       IS DISTINCT FROM ROW(OLD.outcome, OLD.settled_at, OLD.original_run_id, OLD.reason_code) THEN
    IF NOT (OLD.outcome='queued' AND NEW.outcome='queued'
      AND NEW.settled_at IS NOT DISTINCT FROM OLD.settled_at AND NEW.reason_code IS NOT DISTINCT FROM OLD.reason_code
      AND OLD.run_id IS NULL AND OLD.original_run_id IS NULL
      AND NEW.run_id=OLD.reserved_run_id AND NEW.original_run_id=OLD.reserved_run_id
      AND EXISTS(SELECT 1 FROM runs linked JOIN task_launch_intents intent ON intent.id=linked.task_launch_intent_id
        WHERE linked.id=OLD.reserved_run_id AND linked.project_id=OLD.project_id AND linked.source_agent_id=OLD.source_agent_id
          AND intent.run_id=linked.id AND intent.original_run_id=linked.id AND intent.state='run_bound'
          AND intent.project_id=linked.project_id AND intent.task_id=linked.task_id
          AND intent.principal_kind='system'
          AND intent.settings_snapshot->'serverExecution'->>'kind'='agent_trigger'
          AND intent.principal_id='agent_trigger:'||(intent.settings_snapshot->'serverExecution'->>'id')
          AND intent.settings_snapshot->'serverExecution'->'execution'->'agentTriggerReservation'->>'attemptId'=OLD.id
          AND intent.settings_snapshot->'serverExecution'->'execution'->'agentTriggerReservation'->>'runId'=OLD.reserved_run_id
          AND linked.scheduled_request_snapshot IS NOT DISTINCT FROM OLD.scheduled_request_snapshot)) IS TRUE THEN
      RAISE EXCEPTION 'settled agent trigger attempt is immutable for %', OLD.id
        USING ERRCODE='23514', CONSTRAINT='agent_trigger_attempt_settlement_immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
CREATE FUNCTION guard_referenced_flow_revision_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.manifest,NEW.manifest_digest) IS DISTINCT FROM (OLD.manifest,OLD.manifest_digest)
    AND (EXISTS(SELECT 1 FROM runs WHERE flow_revision_id=OLD.id)
      OR EXISTS(SELECT 1 FROM task_launch_intents WHERE settings_snapshot->>'flowRevisionId'=OLD.id)) THEN
    RAISE EXCEPTION 'Referenced Flow revision manifest is immutable; publish a new revision'
      USING ERRCODE='23514',CONSTRAINT='flow_revisions_referenced_manifest_immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER flow_revisions_referenced_manifest_immutable BEFORE UPDATE OF manifest,manifest_digest ON flow_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_referenced_flow_revision_manifest();

--> statement-breakpoint
CREATE FUNCTION lock_consensus_draft_command_hierarchy(child_run_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE child runs%ROWTYPE;
BEGIN
  SELECT * INTO child FROM runs WHERE id=child_run_id;
  IF child.task_admission_snapshot->'version' IS DISTINCT FROM '3'::jsonb THEN RETURN; END IF;
  PERFORM id FROM runs WHERE id=child.parent_run_id FOR UPDATE;
  PERFORM id FROM node_attempts WHERE id=child.task_admission_snapshot->'parent'->>'nodeAttemptId' FOR UPDATE;
  PERFORM id FROM runs WHERE id=child_run_id FOR UPDATE;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lock_consensus_draft_command_admission(child_run_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE child runs%ROWTYPE;
BEGIN
  PERFORM lock_consensus_draft_command_hierarchy(child_run_id);
  SELECT * INTO child FROM runs WHERE id=child_run_id;
  IF child.task_admission_snapshot->'version' IS DISTINCT FROM '3'::jsonb THEN RETURN; END IF;
  PERFORM assert_task_consensus_child_scope(child);
  IF child.status NOT IN ('Running','NeedsInput','NeedsInputIdle') THEN
    RAISE EXCEPTION 'Consensus child command requires its current active execution'
      USING ERRCODE='23514',CONSTRAINT='execution_commands_consensus_child_admission';
  END IF;
END $$;
