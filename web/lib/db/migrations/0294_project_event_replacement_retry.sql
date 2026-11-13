DROP INDEX "runs_agent_trigger_event_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "runs_agent_trigger_event_uq" ON "runs" USING btree ("agent_id","trigger_event_id") WHERE "runs"."trigger_event_id" IS NOT NULL AND "runs"."company_id" IS NULL AND "runs"."retry_of_run_id" IS NULL;
--> statement-breakpoint
CREATE FUNCTION project_event_retry_source_matches(source_id text, requester_id text, appointment jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (
    SELECT 1 FROM runs source
    JOIN agent_trigger_attempts invocation ON invocation.id=appointment->>'attemptId'
      AND invocation.reserved_run_id=source.id AND invocation.run_id=source.id
    JOIN agent_schedules schedule ON schedule.id=invocation.schedule_id AND schedule.id=source.agent_schedule_id
    JOIN domain_events fact ON fact.id=source.trigger_event_id AND fact.id=invocation.trigger_event_id
    WHERE source.id=source_id AND source.retry_of_run_id IS NULL AND source.project_id IS NOT NULL
      AND source.company_id IS NULL AND source.trigger_source='domain_event' AND source.scheduled_request_snapshot IS NULL
      AND appointment=jsonb_build_object('schemaVersion',1,'kind','event','runId',source.id,
        'attemptId',invocation.id,'scheduleId',schedule.id,'eventId',fact.id)
      AND invocation.project_id=source.project_id AND invocation.company_id IS NULL
      AND invocation.source_agent_id=source.source_agent_id AND invocation.trigger_source='domain_event'
      AND invocation.provenance='claim' AND invocation.outcome IN ('queued','launched','deduplicated')
      AND invocation.binding_snapshot->'review'=schedule.project_source_review
      AND invocation.binding_snapshot->'eventKinds'=schedule.event_match->'kinds'
      AND invocation.binding_snapshot->'eventKinds' ? fact.kind
      AND schedule.project_id=source.project_id AND schedule.company_id IS NULL
      AND schedule.enabled AND schedule.trigger_type='event' AND schedule.agent_id=source.source_agent_id
      AND schedule.project_source_review->>'reviewerUserId'=requester_id
      AND fact.project_id=source.project_id AND fact.company_id IS NULL
      AND (fact.run_id IS NULL OR schedule.project_source_review->>'sourceSharing'='producing_run')
    FOR SHARE OF invocation,schedule,fact
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_project_specialist_replacement_retry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  witness jsonb := NEW.recipe->'replacement';
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.recipe->'version' IS DISTINCT FROM '2'::jsonb
       OR NEW.recipe->>'strategy' IS DISTINCT FROM 'pre_work_retry'
       OR NEW.recipe->'taskId' IS DISTINCT FROM 'null'::jsonb
       OR coalesce(NEW.recipe->'trigger'->>'source','') NOT IN ('manual','cron','domain_event')
       OR NEW.actor_user_id IS NULL OR NEW.actor_identity <> 'user:' || NEW.actor_user_id
       OR NEW.state <> 'accepted' OR NEW.created_run_id IS NOT NULL
       OR NOT EXISTS (
      SELECT 1 FROM runs source
      JOIN specialist_run_links link ON link.run_id=source.id AND link.work_id IS NULL
      JOIN specialist_assignments subject ON subject.id=link.assignment_id AND subject.project_id=source.project_id
      JOIN specialist_input_revisions input ON input.assignment_id=subject.id AND input.revision=subject.input_revision
      JOIN specialist_owner_claims owner ON owner.assignment_id=subject.id AND owner.run_id=source.id AND owner.placement_id=source.execution_assignment_id
      JOIN run_sessions session ON session.run_id=source.id AND session.session_name='default'
      WHERE source.id=NEW.source_run_id AND source.project_id=NEW.project_id
        AND source.source_agent_id=NEW.source_agent_id AND source.run_kind='agent' AND source.agent_kind='operational'
        AND source.parent_run_id IS NULL AND source.task_id IS NULL AND source.agent_workspace='none' AND NOT source.persistent
        AND source.trigger_source=NEW.recipe->'trigger'->>'source'
        AND (
          (source.trigger_source='manual' AND subject.origin->>'kind'='manual'
            AND source.agent_schedule_id IS NULL AND source.scheduled_request_snapshot IS NULL AND source.trigger_event_id IS NULL AND NOT (witness ?| ARRAY['cron','event']))
          OR (source.trigger_source='cron' AND subject.origin->>'kind'='schedule'
            AND subject.origin->>'scheduleId'=witness->'cron'->>'scheduleId'
            AND subject.origin->>'triggerAttemptId'=witness->'cron'->>'attemptId'
            AND source.scheduled_request_snapshot=NEW.recipe->'scheduledRequestSnapshot'
            AND NOT (witness ? 'event')
            AND project_cron_retry_source_matches(source.id,NEW.actor_user_id,witness->'cron'))
          OR (source.trigger_source='domain_event' AND subject.origin->>'kind'='event' AND NOT (witness ? 'cron')
            AND subject.origin->>'subscriptionId'=witness->'event'->>'scheduleId'
            AND subject.origin->>'eventId'=witness->'event'->>'eventId'
            AND NEW.recipe->'trigger'->'eventId'=to_jsonb(source.trigger_event_id)
            AND NEW.recipe->'trigger'->'payload'=source.trigger_payload
            AND project_event_retry_source_matches(source.id,NEW.actor_user_id,witness->'event'))
        )
        AND source.status IN ('Failed','Crashed') AND source.ended_at IS NOT NULL
        AND source.result_contract IS NOT NULL AND source.operational_terminal IS NOT NULL
        AND subject.status='active'
        AND subject.requester->>'kind'='user' AND subject.requester->>'id'=NEW.actor_user_id
        AND link.role IN ('specialist','continuation') AND link.input_revision=input.revision
        AND specialist_current_root_id(subject.id,subject.input_revision)=source.id
        AND NOT specialist_other_unsettled_root(subject.id,source.id)
        AND source.knowledge_access->>'state'='complete'
        AND source.knowledge_access->'restrictions' @> jsonb_build_array(jsonb_build_object(
          'kind','assignment_input','assignmentId',subject.id,'inputRevision',input.revision,'inputSha256',input.digest))
        AND witness-ARRAY['cron','event']=jsonb_build_object('sourceRunId',source.id,'assignmentId',subject.id,
          'inputRevision',input.revision,'inputSha256',input.digest,'assignmentRevision',subject.revision,
          'contextRevision',subject.context_revision,'ownerEpoch',owner.epoch,
          'resultSha256',task_launch_admission_digest(source.result_contract),'sourceSha256',company_retry_source_digest(source))
        AND NEW.recipe->'runner'=session.runner_snapshot AND NEW.selected_runner_id=session.runner_id
        AND company_retry_has_dispatch_witness(source.id)
        AND NOT EXISTS(SELECT 1 FROM execution_assignments placement WHERE placement.run_id=source.id AND placement.state='active')
        AND NOT EXISTS(SELECT 1 FROM run_sessions bound WHERE bound.run_id=source.id AND bound.acp_session_id IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM run_session_incarnations incarnation WHERE incarnation.run_id=source.id AND incarnation.state IN ('created','active'))
        AND NOT EXISTS(SELECT 1 FROM execution_commands command WHERE command.run_id=source.id
          AND (command.kind IN ('session.prompt','session.steer') OR (command.kind='session.create'
            AND (command.state='failed' AND command.receipt_evidence->>'phase'='rejected'
              AND command.receipt_evidence->>'inflight'='false') IS NOT TRUE)))
    ) THEN
      RAISE EXCEPTION 'Project replacement retry requires the exact settled source and native assignment'
        USING ERRCODE='23514', CONSTRAINT='project_specialist_replacement_reference';
    END IF;
  ELSIF NEW.state='launched' AND OLD.state IS DISTINCT FROM NEW.state AND NOT EXISTS (
    SELECT 1 FROM runs successor JOIN runs source ON source.id=successor.retry_of_run_id
    JOIN specialist_run_links link ON link.run_id=successor.id
    JOIN run_sessions session ON session.run_id=successor.id AND session.session_name='default'
    WHERE successor.id=NEW.created_run_id AND successor.id=NEW.successor_run_id
      AND successor.project_id=NEW.project_id AND source.id=NEW.source_run_id
      AND successor.status='Pending' AND successor.parent_run_id IS NULL AND successor.task_id IS NULL
      AND successor.source_agent_id=NEW.source_agent_id AND successor.created_by_user_id=NEW.actor_user_id
      AND successor.trigger_source=source.trigger_source
      AND successor.trigger_event_id IS NOT DISTINCT FROM source.trigger_event_id
      AND successor.trigger_payload IS NOT DISTINCT FROM source.trigger_payload
      AND successor.agent_chain_depth=source.agent_chain_depth
      AND successor.agent_schedule_id IS NOT DISTINCT FROM source.agent_schedule_id
      AND successor.scheduled_request_snapshot IS NOT DISTINCT FROM source.scheduled_request_snapshot
      AND successor.result_contract=source.result_contract AND successor.knowledge_access=source.knowledge_access
      AND link.role='continuation' AND link.work_id IS NULL AND link.assignment_id=witness->>'assignmentId'
      AND to_jsonb(link.input_revision)=witness->'inputRevision' AND session.runner_snapshot=NEW.recipe->'runner'
  ) THEN
    RAISE EXCEPTION 'Project replacement retry must reserve the exact successor before settling its receipt'
      USING ERRCODE='23514', CONSTRAINT='project_specialist_replacement_successor';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_project_replacement_event_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (OLD.retry_of_run_id IS NOT NULL OR NEW.retry_of_run_id IS NOT NULL) AND
      ROW(NEW.retry_of_run_id,NEW.project_id,NEW.source_agent_id,NEW.agent_schedule_id,NEW.trigger_event_id,NEW.trigger_source,NEW.agent_chain_depth)
      IS DISTINCT FROM ROW(OLD.retry_of_run_id,OLD.project_id,OLD.source_agent_id,OLD.agent_schedule_id,OLD.trigger_event_id,OLD.trigger_source,OLD.agent_chain_depth) THEN
      RAISE EXCEPTION 'Project event replacement source identity is immutable'
        USING ERRCODE='23514',CONSTRAINT='project_event_replacement_source_scope';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agent_retry_intents intent JOIN runs source ON source.id=intent.source_run_id
    WHERE intent.project_id=NEW.project_id AND intent.company_id IS NULL
      AND intent.successor_run_id=NEW.id AND source.id=NEW.retry_of_run_id
      AND intent.state='accepted' AND intent.actor_user_id=NEW.created_by_user_id
      AND source.source_agent_id=NEW.source_agent_id AND source.trigger_event_id=NEW.trigger_event_id
      AND source.agent_schedule_id=NEW.agent_schedule_id AND source.agent_chain_depth=NEW.agent_chain_depth
      AND NEW.trigger_source='domain_event'
      AND project_event_retry_source_matches(source.id,intent.actor_user_id,intent.recipe->'replacement'->'event')
  ) THEN
    RAISE EXCEPTION 'Project event replacement requires its exact accepted original appointment'
      USING ERRCODE='23514',CONSTRAINT='project_event_replacement_source_scope';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER project_replacement_event_insert BEFORE INSERT ON runs FOR EACH ROW
WHEN (NEW.company_id IS NULL AND NEW.trigger_event_id IS NOT NULL AND NEW.retry_of_run_id IS NOT NULL)
EXECUTE FUNCTION guard_project_replacement_event_run();
--> statement-breakpoint
CREATE TRIGGER project_replacement_event_update BEFORE UPDATE OF retry_of_run_id,project_id,source_agent_id,agent_schedule_id,trigger_event_id,trigger_source,agent_chain_depth ON runs
FOR EACH ROW WHEN (NEW.company_id IS NULL AND (NEW.trigger_event_id IS NOT NULL OR OLD.trigger_event_id IS NOT NULL)
  AND (NEW.retry_of_run_id IS NOT NULL OR OLD.retry_of_run_id IS NOT NULL))
EXECUTE FUNCTION guard_project_replacement_event_run();
