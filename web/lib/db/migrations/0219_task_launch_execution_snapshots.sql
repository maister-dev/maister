ALTER TABLE "task_launch_intents" DROP CONSTRAINT "task_launch_intents_snapshot_check";--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD CONSTRAINT "task_launch_intents_snapshot_check" CHECK ((jsonb_typeof("task_launch_intents"."input_snapshot")='object' AND "task_launch_intents"."input_snapshot"->'version' IN ('1'::jsonb,'2'::jsonb) AND "task_launch_intents"."input_snapshot"->>'projectId'="task_launch_intents"."project_id" AND "task_launch_intents"."input_snapshot"->>'taskId'="task_launch_intents"."task_id" AND jsonb_typeof("task_launch_intents"."input_snapshot"->'title')='string' AND jsonb_typeof("task_launch_intents"."input_snapshot"->'prompt')='string' AND jsonb_typeof("task_launch_intents"."input_snapshot"->'clarifications')='array' AND jsonb_array_length("task_launch_intents"."input_snapshot"->'clarifications')<=1000 AND octet_length("task_launch_intents"."input_snapshot"::text)<=262144 AND jsonb_typeof("task_launch_intents"."settings_snapshot")='object' AND "task_launch_intents"."settings_snapshot"->'version' IN ('1'::jsonb,'2'::jsonb) AND ("task_launch_intents"."settings_snapshot"->>'kind'='flow' AND jsonb_typeof("task_launch_intents"."settings_snapshot"->'flowId')='string' AND jsonb_typeof("task_launch_intents"."settings_snapshot"->'flowRevisionId')='string' AND "task_launch_intents"."settings_snapshot"->'agentId'='null'::jsonb AND "task_launch_intents"."settings_snapshot"->'definitionSha256'='null'::jsonb OR "task_launch_intents"."settings_snapshot"->>'kind'='agent' AND "task_launch_intents"."settings_snapshot"->'flowId'='null'::jsonb AND "task_launch_intents"."settings_snapshot"->'flowRefId'='null'::jsonb AND "task_launch_intents"."settings_snapshot"->'flowRevisionId'='null'::jsonb AND jsonb_typeof("task_launch_intents"."settings_snapshot"->'agentId')='string' AND "task_launch_intents"."settings_snapshot"->>'definitionSha256' ~ '^[0-9a-f]{64}$') AND jsonb_typeof("task_launch_intents"."settings_snapshot"->'sessions')='array' AND jsonb_array_length("task_launch_intents"."settings_snapshot"->'sessions') BETWEEN 1 AND 64 AND ("task_launch_intents"."settings_snapshot"->>'baseCommit' ~ '^[0-9a-f]{40}([0-9a-f]{24})?$' OR "task_launch_intents"."settings_snapshot"->>'kind'='agent' AND "task_launch_intents"."settings_snapshot"->>'workspace'='none' AND "task_launch_intents"."settings_snapshot"->'baseCommit'='null'::jsonb) AND jsonb_typeof("task_launch_intents"."settings_snapshot"->'autoPromote')='boolean' AND jsonb_typeof("task_launch_intents"."settings_snapshot"->'executionPolicy')='object' AND jsonb_typeof("task_launch_intents"."settings_snapshot"->'deliveryPolicy')='object' AND octet_length("task_launch_intents"."settings_snapshot"::text)<=131072 AND jsonb_typeof("task_launch_intents"."basis")='object' AND "task_launch_intents"."basis"->>'kind' IN ('manual','automatic','execution_child') AND ("task_launch_intents"."basis"->>'kind'<>'manual' OR "task_launch_intents"."principal_kind"='session_user' AND "task_launch_intents"."actor_user_id"="task_launch_intents"."principal_id" AND "task_launch_intents"."basis"->>'userId'="task_launch_intents"."actor_user_id") AND ("task_launch_intents"."basis"->>'kind'<>'automatic' OR jsonb_typeof("task_launch_intents"."basis"->'qualificationId')='string' AND jsonb_typeof("task_launch_intents"."basis"->'qualificationRevision')='number' AND "task_launch_intents"."basis"->>'qualificationInputDigest' ~ '^[0-9a-f]{64}$' AND "task_launch_intents"."basis"->>'evidenceSha' ~ '^[0-9a-f]{40}([0-9a-f]{24})?$') AND ("task_launch_intents"."basis"->>'kind'<>'execution_child' OR jsonb_typeof("task_launch_intents"."basis"->'parent')='object')) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_task_launch_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target tasks%ROWTYPE; assessment task_qualifications%ROWTYPE; slot jsonb; seen_slots text[]:=ARRAY[]::text[];
BEGIN
  IF current_setting('maister.task_launch_writer',true) IS DISTINCT FROM 'v2' THEN
    RAISE EXCEPTION 'Task launch writer v2 required; keep incompatible writers stopped under upgrade maintenance'
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
      OLD.state='preparing' AND NEW.state IN ('queued','run_bound','held','cancelled','failed') OR
      OLD.state='held' AND NEW.state IN ('queued','cancelled') OR
      OLD.state='run_bound' AND NEW.state IN ('held','cancelled','settled') OR
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
        OR assessment.evidence_sha IS DISTINCT FROM NEW.settings_snapshot->>'baseCommit' THEN
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
CREATE OR REPLACE FUNCTION guard_run_task_launch_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent task_launch_intents%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND OLD.task_launch_intent_id IS DISTINCT FROM NEW.task_launch_intent_id THEN
    RAISE EXCEPTION 'Run launch authority is write-once'
      USING ERRCODE='23514',CONSTRAINT='runs_task_launch_binding_immutable';
  END IF;
  IF NEW.task_launch_intent_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO intent FROM task_launch_intents WHERE id=NEW.task_launch_intent_id FOR SHARE;
  IF current_setting('maister.task_launch_writer',true) IS DISTINCT FROM 'v2' OR NOT FOUND
    OR intent.project_id IS DISTINCT FROM NEW.project_id OR intent.task_id IS DISTINCT FROM NEW.task_id
    OR intent.input_snapshot->'version' IS DISTINCT FROM '2'::jsonb
    OR intent.settings_snapshot->'version' IS DISTINCT FROM '2'::jsonb
    OR NEW.resolved_capability_set IS DISTINCT FROM nullif(intent.settings_snapshot->'resolvedCapabilitySet','null'::jsonb)
    OR intent.state<>'preparing' OR intent.lease_expires_at<=clock_timestamp()
    OR NEW.task_admission_snapshot->>'intentId' IS DISTINCT FROM intent.id
    OR NEW.task_admission_snapshot->>'basis' IS DISTINCT FROM intent.basis->>'kind'
    OR NEW.task_admission_snapshot->'inputRevision' IS DISTINCT FROM to_jsonb(intent.input_revision)
    OR NEW.task_admission_snapshot->>'evidenceSha' IS DISTINCT FROM intent.settings_snapshot->>'baseCommit'
    OR NEW.task_admission_snapshot->>'evidenceTarget' IS DISTINCT FROM intent.settings_snapshot->>'baseBranch'
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
CREATE OR REPLACE FUNCTION guard_task_launch_writer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE guarded boolean;
BEGIN
  IF TG_TABLE_NAME='runs' THEN
    guarded:=NEW.task_launch_intent_id IS NOT NULL;
  ELSE
    SELECT EXISTS(SELECT 1 FROM task_launch_intents WHERE task_id=NEW.id AND state IN ('queued','preparing','run_bound','held')) INTO guarded;
  END IF;
  IF guarded AND current_setting('maister.task_launch_writer',true) IS DISTINCT FROM 'v2' THEN
    RAISE EXCEPTION 'Task launch writer v2 required; keep incompatible writers stopped under upgrade maintenance'
      USING ERRCODE='23514',CONSTRAINT='task_launch_writer_capability';
  END IF;
  RETURN NEW;
END $$;
