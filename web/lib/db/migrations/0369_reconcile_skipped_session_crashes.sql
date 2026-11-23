-- Restore exact crashes skipped after the permission owner released assignment.
-- Leave pending events to the lifecycle projector and retain current bindings.
WITH skipped_crash AS (
  SELECT DISTINCT ON (incarnation.id)
    incarnation.id AS incarnation_id,
    crash.id AS event_id,
    crash.occurred_at,
    COALESCE(crash.payload, '{}'::jsonb) AS terminal_reason
  FROM run_session_incarnations incarnation
  JOIN execution_assignments assignment
    ON assignment.id = incarnation.execution_assignment_id
    AND assignment.state <> 'active'
  JOIN execution_event_consumers cursor
    ON cursor.run_id = incarnation.run_id
    AND cursor.consumer_name = 'canonical-session-lifecycle-v1'
  JOIN execution_events crash
    ON crash.run_id = incarnation.run_id
    AND crash.execution_host_id = incarnation.execution_host_id
    AND crash.execution_assignment_id = incarnation.execution_assignment_id
    AND crash.assignment_epoch = incarnation.assignment_epoch
    AND crash.host_session_id = incarnation.host_session_id
    AND crash.run_sequence <= cursor.last_run_sequence
  WHERE incarnation.state IN ('created', 'active', 'lost')
    AND crash.event_type = 'session.crashed'
    AND crash.source = 'host'
    AND crash.ingest_disposition = 'accepted'
    AND crash.run_session_incarnation_id IS NULL
  ORDER BY incarnation.id, crash.run_sequence
), settled AS (
  UPDATE run_session_incarnations incarnation
  SET state = 'crashed',
      ended_at = skipped_crash.occurred_at,
      terminal_reason = skipped_crash.terminal_reason
  FROM skipped_crash
  WHERE incarnation.id = skipped_crash.incarnation_id
    AND incarnation.state IN ('created', 'active', 'lost')
  RETURNING incarnation.id, skipped_crash.event_id
)
UPDATE execution_events event
SET run_session_incarnation_id = settled.id
FROM settled
WHERE event.id = settled.event_id
  AND event.run_session_incarnation_id IS NULL;
