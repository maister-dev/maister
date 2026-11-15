CREATE OR REPLACE FUNCTION public.specialist_interrupted_child_prompt(work_id text, work_revision integer, result_id text)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;
