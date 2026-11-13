DROP INDEX "runs_company_trigger_event_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "runs_company_trigger_event_uq" ON "runs" USING btree ("company_id","source_agent_id","agent_schedule_id","trigger_event_id") WHERE "runs"."company_id" IS NOT NULL AND "runs"."trigger_event_id" IS NOT NULL AND "runs"."retry_of_run_id" IS NULL;
--> statement-breakpoint
CREATE FUNCTION company_event_retry_source(source_id text, requester_id text)
RETURNS TABLE(schedule_id text,event_id bigint,chain_depth integer,producing_run_id text)
LANGUAGE sql VOLATILE AS $$
  SELECT schedule.id,event.id,source.agent_chain_depth,producing.id
  FROM runs source
  JOIN agent_trigger_attempts invocation ON invocation.reserved_run_id=source.id AND invocation.run_id=source.id
  JOIN agent_schedules schedule ON schedule.id=invocation.schedule_id AND schedule.id=source.agent_schedule_id
  JOIN domain_events event ON event.id=invocation.trigger_event_id AND event.id=source.trigger_event_id
  JOIN runs producing ON producing.id=event.run_id AND producing.company_id=source.company_id AND producing.project_id IS NULL
  JOIN company_grants sharing ON sharing.company_id=source.company_id AND sharing.principal_type='agent'
    AND sharing.principal_id=source.source_agent_id AND sharing.action='assignments:read' AND sharing.revoked_at IS NULL
  WHERE source.id=source_id AND source.trigger_source='domain_event' AND source.retry_of_run_id IS NULL
    AND source.company_id IS NOT NULL AND source.project_id IS NULL AND source.scheduled_request_snapshot IS NULL
    AND schedule.company_id=source.company_id AND schedule.project_id IS NULL AND schedule.enabled
    AND schedule.trigger_type='event' AND schedule.created_by=requester_id
    AND invocation.company_id=source.company_id AND invocation.project_id IS NULL
    AND invocation.trigger_source='domain_event' AND invocation.outcome IN ('queued','launched','deduplicated')
    AND invocation.binding_snapshot->'sourceRevision'=to_jsonb(schedule.company_config_revision)
    AND invocation.binding_snapshot->'specialistBinding'=source.company_execution_snapshot->'specialistBinding'
    AND invocation.binding_snapshot->'coordinatorFlowBinding' IS NOT DISTINCT FROM
      coalesce(source.company_execution_snapshot->'coordinatorFlowBinding','null'::jsonb)
    AND invocation.binding_snapshot->'eventKinds' ? event.kind
    AND event.company_id=source.company_id AND event.project_id IS NULL
    AND producing.knowledge_access->>'state'='complete'
  FOR SHARE OF invocation,schedule,event,producing,sharing
$$;
--> statement-breakpoint
CREATE FUNCTION company_event_retry_still_authorized(successor_id text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (
    SELECT 1 FROM runs successor JOIN agent_retry_intents intent
      ON intent.successor_run_id=successor.id AND intent.source_run_id=successor.retry_of_run_id
      AND intent.company_id=successor.company_id AND intent.recipe ? 'replacement'
      AND ((intent.state='launched' AND intent.created_run_id=successor.id)
        OR (intent.state='accepted' AND successor.status='Pending'))
    JOIN LATERAL company_event_retry_source(intent.source_run_id,intent.actor_user_id) source ON true
    WHERE successor.id=successor_id AND successor.trigger_source='domain_event'
      AND source.schedule_id=successor.agent_schedule_id AND source.event_id=successor.trigger_event_id
      AND source.chain_depth=successor.agent_chain_depth
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_company_replacement_retry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  witness jsonb := NEW.recipe->'replacement';
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'accepted' OR NEW.created_run_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM runs source
      JOIN specialist_run_links link ON link.run_id=source.id
      JOIN specialist_assignments subject ON subject.id=link.assignment_id
      JOIN specialist_owner_claims owner ON owner.assignment_id=subject.id AND owner.run_id=source.id
        AND owner.placement_id=source.execution_assignment_id
      LEFT JOIN run_sessions session ON session.run_id=source.id AND session.session_name='default'
      WHERE source.id=NEW.source_run_id AND source.company_id=NEW.company_id
        AND source.source_agent_id=NEW.source_agent_id
        AND source.parent_run_id IS NULL AND source.status IN ('Failed','Crashed') AND source.ended_at IS NOT NULL
        AND source.agent_workspace='none'
        AND source.trigger_source=NEW.recipe->'trigger'->>'source'
        AND (
          (source.trigger_source='manual' AND source.agent_schedule_id IS NULL)
          OR (source.trigger_source='cron' AND source.retry_of_run_id IS NULL
            AND source.scheduled_request_snapshot=NEW.recipe->'scheduledRequestSnapshot'
            AND company_cron_retry_source_schedule(source.id,NEW.actor_user_id)=source.agent_schedule_id)
          OR (source.trigger_source='domain_event' AND source.retry_of_run_id IS NULL
            AND NEW.recipe->'trigger'->'eventId'=to_jsonb(source.trigger_event_id)
            AND EXISTS(SELECT 1 FROM company_event_retry_source(source.id,NEW.actor_user_id)))
        )
        AND source.result_contract IS NOT NULL
        AND (
          (source.run_kind='agent' AND source.operational_terminal IS NOT NULL
            AND NOT (witness ? 'sessionsSha256') AND NEW.recipe->'coordinatorFlowBinding'='null'::jsonb
            AND NEW.recipe->'runner'=session.runner_snapshot AND company_retry_has_dispatch_witness(source.id))
          OR (source.run_kind='flow' AND source.operational_terminal IS NULL
            AND NEW.recipe->'coordinatorFlowBinding'=source.company_execution_snapshot->'coordinatorFlowBinding'
            AND witness->>'sessionsSha256'=company_flow_retry_sessions_digest(source.id)
            AND company_flow_retry_has_dispatch_witness(source.id)
            AND EXISTS (SELECT 1 FROM run_sessions slot WHERE slot.run_id=source.id
              AND slot.runner_snapshot=NEW.recipe->'runner' AND slot.runner_id=NEW.selected_runner_id))
        )
        AND link.assignment_id=NEW.recipe->'assignment'->>'id'
        AND subject.status='active' AND specialist_current_root_id(subject.id,subject.input_revision)=source.id
        AND NOT specialist_other_unsettled_root(subject.id,source.id)
        AND witness->'sourceRunId'=to_jsonb(source.id)
        AND witness->'ownerEpoch'=to_jsonb(owner.epoch)
        AND witness->'contextRevision'=to_jsonb(subject.context_revision)
        AND witness->'assignmentRevision'=to_jsonb(subject.revision)
        AND witness->>'resultSha256'=task_launch_admission_digest(source.result_contract)
        AND witness->>'sourceSha256'=company_retry_source_digest(source)
        AND NOT EXISTS(SELECT 1 FROM execution_assignments placement WHERE placement.run_id=source.id AND placement.state='active')
        AND NOT EXISTS(SELECT 1 FROM run_sessions bound WHERE bound.run_id=source.id AND bound.acp_session_id IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM run_session_incarnations incarnation WHERE incarnation.run_id=source.id AND incarnation.state IN ('created','active'))
        AND NOT EXISTS(SELECT 1 FROM execution_commands command WHERE command.run_id=source.id
          AND (command.kind IN ('session.prompt','session.steer') OR (command.kind='session.create'
            AND (command.state='failed' AND command.receipt_evidence->>'phase'='rejected'
              AND command.receipt_evidence->>'inflight'='false') IS NOT TRUE)))
    ) THEN
      RAISE EXCEPTION 'Replacement retry requires the exact settled specialist Run and current owner'
        USING ERRCODE='23514',CONSTRAINT='company_retry_replacement_reference';
    END IF;
  ELSIF NEW.state='launched' AND OLD.state IS DISTINCT FROM NEW.state AND NOT EXISTS (
    SELECT 1 FROM runs source JOIN runs successor ON successor.id=NEW.created_run_id
    JOIN specialist_run_links link ON link.run_id=successor.id
    LEFT JOIN run_sessions session ON session.run_id=successor.id AND session.session_name='default'
    WHERE source.id=NEW.source_run_id AND successor.id=NEW.successor_run_id
      AND successor.company_id=NEW.company_id AND successor.parent_run_id IS NULL
      AND successor.status='Pending' AND successor.retry_of_run_id=source.id AND link.work_id IS NULL
      AND ((source.run_kind='agent' AND successor.run_kind='agent' AND link.role='continuation'
        AND session.runner_snapshot=NEW.recipe->'runner')
        OR (source.run_kind='flow' AND successor.run_kind='flow' AND link.role='coordinator'
          AND successor.company_execution_snapshot->'coordinatorFlowBinding'=NEW.recipe->'coordinatorFlowBinding'
          AND witness->>'sessionsSha256'=company_flow_retry_sessions_digest(successor.id)))
      AND link.assignment_id=NEW.recipe->'assignment'->>'id'
      AND successor.company_execution_snapshot->'assignment'=NEW.recipe->'assignment'
      AND successor.company_execution_snapshot->'specialistBinding'=NEW.recipe->'specialistBinding'
      AND successor.trigger_source=source.trigger_source
      AND successor.trigger_event_id IS NOT DISTINCT FROM source.trigger_event_id
      AND successor.agent_chain_depth=source.agent_chain_depth
      AND successor.agent_schedule_id IS NOT DISTINCT FROM source.agent_schedule_id
      AND successor.scheduled_request_snapshot IS NOT DISTINCT FROM source.scheduled_request_snapshot
      AND successor.result_contract=source.result_contract
      AND successor.knowledge_access=source.knowledge_access
  ) THEN
    RAISE EXCEPTION 'Replacement retry must reserve the exact successor before settling its receipt'
      USING ERRCODE='23514',CONSTRAINT='company_retry_replacement_successor';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_company_event_run_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ((OLD.company_id IS NOT NULL AND OLD.trigger_source='domain_event') OR (NEW.company_id IS NOT NULL AND NEW.trigger_source='domain_event')) AND
      ROW(NEW.company_id,NEW.project_id,NEW.source_agent_id,NEW.agent_schedule_id,NEW.trigger_event_id,NEW.trigger_source,NEW.company_execution_snapshot,NEW.retry_of_run_id)
      IS DISTINCT FROM ROW(OLD.company_id,OLD.project_id,OLD.source_agent_id,OLD.agent_schedule_id,OLD.trigger_event_id,OLD.trigger_source,OLD.company_execution_snapshot,OLD.retry_of_run_id) THEN
      RAISE EXCEPTION 'Company event execution source identity is immutable' USING ERRCODE='23514',CONSTRAINT='runs_company_event_source_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.company_id IS NULL OR NEW.trigger_source IS DISTINCT FROM 'domain_event' THEN RETURN NEW; END IF;
  IF NEW.retry_of_run_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM agent_retry_intents intent
      JOIN LATERAL company_event_retry_source(NEW.retry_of_run_id,NEW.created_by_user_id) source ON true
      WHERE intent.company_id=NEW.company_id AND intent.source_agent_id=NEW.source_agent_id
        AND intent.source_run_id=NEW.retry_of_run_id AND intent.successor_run_id=NEW.id
        AND intent.state='accepted' AND intent.actor_user_id=NEW.created_by_user_id
        AND intent.recipe ? 'replacement'
        AND source.schedule_id=NEW.agent_schedule_id AND source.event_id=NEW.trigger_event_id
        AND source.chain_depth=NEW.agent_chain_depth
        AND intent.recipe->'assignment'=NEW.company_execution_snapshot->'assignment'
    ) THEN
      RAISE EXCEPTION 'Company event replacement requires its exact accepted original invocation'
        USING ERRCODE='23514',CONSTRAINT='runs_company_event_source_scope';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agent_trigger_attempts invocation
    JOIN domain_events event ON event.id=invocation.trigger_event_id AND event.company_id=invocation.company_id AND event.project_id IS NULL
    JOIN specialist_assignments requested ON requested.id=NEW.company_execution_snapshot->'assignment'->>'id'
      AND requested.company_id=NEW.company_id AND requested.project_id IS NULL
    WHERE invocation.reserved_run_id=NEW.id AND invocation.company_id=NEW.company_id AND invocation.project_id IS NULL
      AND invocation.source_agent_id=NEW.source_agent_id AND invocation.schedule_id=NEW.agent_schedule_id
      AND invocation.trigger_source='domain_event' AND invocation.trigger_event_id=NEW.trigger_event_id AND invocation.outcome IS NULL
      AND requested.origin->>'kind'='event' AND requested.origin->>'eventId'=event.id::text
      AND requested.origin->>'subscriptionId'=invocation.schedule_id
    FOR SHARE OF invocation,event,requested
  ) THEN
    RAISE EXCEPTION 'Company event execution requires its exact owned invocation and assignment origin' USING ERRCODE='23514',CONSTRAINT='runs_company_event_source_scope';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER runs_company_event_source_guard ON runs;
--> statement-breakpoint
CREATE TRIGGER runs_company_event_source_guard BEFORE INSERT OR UPDATE OF company_id,project_id,source_agent_id,agent_schedule_id,trigger_event_id,trigger_source,company_execution_snapshot,retry_of_run_id ON runs FOR EACH ROW EXECUTE FUNCTION guard_company_event_run_source();
