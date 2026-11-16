ALTER TABLE "specialist_work_decisions" ADD COLUMN "interruption_command_id" text;--> statement-breakpoint
ALTER TABLE "specialist_work_decisions" ADD CONSTRAINT "specialist_work_decisions_interruption_command_id_execution_commands_id_fk" FOREIGN KEY ("interruption_command_id") REFERENCES "public"."execution_commands"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION specialist_interrupted_child_prompt(work_id text, work_revision integer, result_id text)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT prompt.id FROM specialist_work work
  JOIN runs child ON child.id=work.child_run_id AND child.parent_run_id=work.parent_run_id
  JOIN company_specialist_binding_revisions role ON role.binding_id=child.company_execution_snapshot#>>'{specialistBinding,id}'
    AND role.revision::text=child.company_execution_snapshot#>>'{specialistBinding,revision}'
    AND role.snapshot_digest=child.company_execution_snapshot#>>'{specialistBinding,snapshotSha256}'
  JOIN run_results outcome ON outcome.id=$3 AND outcome.run_id=child.id
  JOIN execution_assignments placement ON placement.id=child.execution_assignment_id AND placement.run_id=child.id
  JOIN agent_turns turn ON turn.run_id=child.id AND turn.execution_assignment_id=placement.id
  JOIN execution_commands prompt ON prompt.id=turn.command_id AND prompt.run_id=child.id
    AND prompt.execution_assignment_id=placement.id AND prompt.assignment_epoch=placement.epoch
  JOIN run_session_incarnations session ON session.id=turn.incarnation_id AND session.run_id=child.id
    AND session.execution_assignment_id=placement.id AND session.host_session_id=prompt.target_session_id
  JOIN execution_events terminal ON terminal.id=prompt.terminal_event_id
  WHERE work.id=$1 AND work.work_revision=$2 AND work.work_revision=1
    AND work.definition#>>'{target,kind}'='company_agent'
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(work.definition#>'{objectiveInput,verification}') requirement
      WHERE requirement->>'kind' IS DISTINCT FROM 'result')
    AND child.company_id IS NOT NULL AND child.project_id IS NULL AND child.agent_kind='operational'
    AND child.agent_workspace='none' AND NOT child.persistent AND child.company_cancellation_intent IS NULL
    AND child.status IN ('Failed','Crashed') AND child.ended_at IS NOT NULL AND placement.state='released'
    AND role.snapshot#>>'{definition,riskTier}'='read_only'
    AND role.snapshot->'grantActions' <@ '["assignments:read","knowledge:read","targets:read","targets:logs"]'::jsonb
    AND outcome.validity='invalid' AND outcome.invalid_reason='result_missing' AND outcome.first_collected_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM run_results published WHERE published.run_id=child.id AND published.validity='valid')
    AND NOT EXISTS (SELECT 1 FROM execution_commands effect WHERE effect.run_id=child.id AND effect.kind='stand.dispatch')
    AND NOT EXISTS (SELECT 1 FROM stand_operations effect WHERE effect.initiating_execution->>'runId'=child.id
      AND effect.action='restart')
    AND turn.variant='initial' AND turn.state='applied' AND session.state='crashed'
    AND prompt.kind='session.prompt' AND prompt.state='failed' AND prompt.accepted_at IS NOT NULL
    AND prompt.application_state='applied' AND terminal.ingest_disposition='accepted'
    AND terminal.run_id=child.id AND terminal.execution_assignment_id=placement.id
    AND terminal.execution_host_id=prompt.execution_host_id AND terminal.assignment_epoch=placement.epoch
    AND terminal.host_session_id=prompt.target_session_id
    AND EXISTS (
      SELECT 1 FROM execution_events crash WHERE crash.source='host'
        AND crash.event_type='session.crashed' AND crash.ingest_disposition='accepted'
        AND crash.run_id=child.id AND crash.event_stream_id=terminal.event_stream_id
        AND crash.execution_host_id=terminal.execution_host_id AND crash.execution_assignment_id=placement.id
        AND crash.assignment_epoch=placement.epoch AND crash.host_session_id=prompt.target_session_id
        AND (crash.run_session_incarnation_id IS NULL OR crash.run_session_incarnation_id=session.id)
        AND crash.host_sequence<terminal.host_sequence
    )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_specialist_work_rework_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Logical work decisions are immutable'
      USING ERRCODE='23514',CONSTRAINT='specialist_work_decision_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM specialist_work work
    JOIN runs child ON child.id=work.child_run_id AND child.parent_run_id=work.parent_run_id
    JOIN runs parent ON parent.id=work.parent_run_id
    JOIN run_results result ON result.id=NEW.result_id AND result.run_id=child.id
    WHERE work.id=NEW.work_id AND work.work_revision=NEW.work_revision
      AND work.input_revision=NEW.input_revision AND work.revision=NEW.expected_revision
      AND work.decision_state='open'
      AND (
        (NEW.decision IN ('accept','reject') AND NEW.actor->>'kind'='user' AND EXISTS (
          SELECT 1 FROM users author WHERE author.id=NEW.actor->>'id' AND author.account_status='active'
        )) OR (NEW.actor->>'kind'='agent' AND parent.status='Running' AND
          NEW.actor->>'runId'=work.parent_run_id AND NEW.actor->>'id'=work.actor->>'id'
          AND (
            (parent.run_kind='agent' AND NEW.actor->'attemptId'='null'::jsonb)
            OR (parent.run_kind='flow' AND EXISTS (
              SELECT 1 FROM node_attempts node
              WHERE node.id=NEW.actor->>'attemptId' AND node.run_id=parent.id AND node.node_id=parent.current_step_id
                AND node.status='Running' AND node.knowledge_actor->>'agentId'=NEW.actor->>'id'
                AND NOT EXISTS (
                  SELECT 1 FROM node_attempts newer WHERE newer.run_id=node.run_id AND newer.node_id=node.node_id AND newer.attempt>node.attempt
                )
            ))
          )
        )
      )
      AND result.revision=NEW.result_revision
      AND (
        (NEW.interruption_command_id IS NULL AND child.status='Done'
          AND result.validity='valid' AND result.first_collected_at IS NOT NULL)
        OR (NEW.interruption_command_id IS NOT NULL AND NEW.decision='rework'
          AND NEW.actor->>'kind'='agent' AND NEW.reason=work.definition->'objectiveInput'->>'objective'
          AND specialist_interrupted_child_prompt(work.id,work.work_revision,result.id)=NEW.interruption_command_id)
      )
      AND result.schema_ref=work.definition->'objectiveInput'->'expectedResult'->>'schemaRef'
      AND result.schema_version::text=work.definition->'objectiveInput'->'expectedResult'->>'schemaVersion'
      AND result.schema_sha256=work.definition->'objectiveInput'->'expectedResult'->>'sha256'
  ) THEN
    RAISE EXCEPTION 'A work decision requires the exact collected result and work revision'
      USING ERRCODE='23514',CONSTRAINT='specialist_work_decision_result_required';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION require_specialist_work_rework_continuation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decision='accept' THEN
    IF NOT EXISTS (
      SELECT 1 FROM specialist_work work
      JOIN specialist_context_revisions history ON history.assignment_id=work.assignment_id
      WHERE work.id=NEW.work_id AND work.work_revision=NEW.work_revision AND work.decision_state='accepted'
        AND history.context->'entries' @> jsonb_build_array(jsonb_build_object(
          'entry',jsonb_build_object('kind','accepted','acceptedWork',jsonb_build_object('decisionId',NEW.id))
        ))
    ) THEN
      RAISE EXCEPTION 'Work acceptance requires its exact accepted working-context entry'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_acceptance_context_required';
    END IF;
    RETURN NEW;
  ELSIF NEW.decision='reject' THEN
    IF NOT EXISTS (
      SELECT 1 FROM specialist_work work
      JOIN specialist_context_revisions history ON history.assignment_id=work.assignment_id
      WHERE work.id=NEW.work_id AND work.work_revision=NEW.work_revision AND work.decision_state='rejected'
        AND history.input_revision=NEW.input_revision AND history.actor=NEW.actor
        AND history.request_key='reject-'||NEW.id AND history.request_digest=NEW.request_sha256
        AND history.context->'entries' @> jsonb_build_array(jsonb_build_object(
          'actor',NEW.actor,'introducedRevision',history.revision,
          'entry',jsonb_build_object('id',NEW.id,'kind','decision','state','resolved','text',NEW.reason)
        ))
    ) THEN
      RAISE EXCEPTION 'Work rejection requires its exact attributed working-context entry'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_rejection_context_required';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM specialist_work prior JOIN specialist_work continuation
      ON continuation.id=prior.id AND continuation.work_revision=prior.work_revision+1
    WHERE prior.id=NEW.work_id AND prior.work_revision=NEW.work_revision
      AND prior.decision_state='rework_requested'
      AND (NEW.interruption_command_id IS NULL OR (continuation.input_revision=prior.input_revision
        AND continuation.input_sha256=prior.input_sha256
        AND continuation.definition->'objectiveInput'=prior.definition->'objectiveInput'))
  ) THEN
    RAISE EXCEPTION 'A rework decision requires its next retained work definition'
      USING ERRCODE='23514',CONSTRAINT='specialist_work_rework_continuation_required';
  END IF;
  RETURN NEW;
END $$;
