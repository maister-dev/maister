-- M43 / ADR-129: terminalize actionable legacy steps[] Flow runs (D2), then
-- irreversibly remove their detailed step ledger (D1). Drizzle runs this file
-- in one transaction; every mutation below is therefore all-or-nothing.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM runs r
    LEFT JOIN flow_revisions fr ON fr.id = r.flow_revision_id
    LEFT JOIN flows f ON f.id = r.flow_id
    WHERE r.run_kind = 'flow'
      AND r.status IN (
        'Pending', 'Running', 'NeedsInput', 'NeedsInputIdle',
        'HumanWorking', 'WaitingOnChildren', 'Review', 'Crashed'
      )
      AND (
        r.project_id IS NULL
        OR (
          r.flow_revision_id IS NOT NULL
          AND (
            fr.id IS NULL
            OR f.id IS NULL
            OR fr.flow_ref_id <> f.flow_ref_id
          )
        )
        OR (
          r.flow_revision_id IS NULL
          AND f.id IS NULL
        )
        OR CASE
          WHEN r.flow_revision_id IS NOT NULL THEN fr.manifest IS NULL
          ELSE f.manifest IS NULL
        END
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '0093 graph-only cut-over aborted: actionable Flow run has unresolved or ambiguous manifest/project identity';
  END IF;
END $$;
--> statement-breakpoint

CREATE TEMP TABLE _m93_cutover_candidates ON COMMIT DROP AS
SELECT
  r.id AS run_id,
  r.status AS prior_status,
  r.project_id,
  r.task_id,
  r.flow_id,
  r.parent_run_id
FROM runs r
LEFT JOIN flow_revisions fr ON fr.id = r.flow_revision_id
LEFT JOIN flows f ON f.id = r.flow_id
WHERE r.run_kind = 'flow'
  AND r.status IN (
    'Pending', 'Running', 'NeedsInput', 'NeedsInputIdle',
    'HumanWorking', 'WaitingOnChildren', 'Review', 'Crashed'
  )
  AND CASE
    WHEN r.flow_revision_id IS NOT NULL THEN fr.manifest ? 'steps'
    ELSE f.manifest ? 'steps'
  END;
--> statement-breakpoint

UPDATE node_attempts na
SET status = 'Failed',
    error_code = 'CONFIG',
    acp_session_id = NULL,
    ended_at = COALESCE(na.ended_at, clock_timestamp())
FROM _m93_cutover_candidates c
WHERE na.run_id = c.run_id
  AND na.ended_at IS NULL;
--> statement-breakpoint

UPDATE hitl_requests h
SET response = jsonb_build_object(
      'cancelled', true,
      'reason', 'legacy_steps_engine_3_cutover',
      'source', 'upgrade_cutover'
    ),
    responded_at = clock_timestamp()
FROM _m93_cutover_candidates c
WHERE h.run_id = c.run_id
  AND h.responded_at IS NULL;
--> statement-breakpoint

CREATE TEMP TABLE _m93_closed_assignments ON COMMIT DROP AS
WITH active AS (
  SELECT
    a.id,
    a.project_id,
    a.run_id,
    a.status AS from_status
  FROM assignments a
  JOIN _m93_cutover_candidates c ON c.run_id = a.run_id
  WHERE a.status IN ('open', 'claimed')
), updated AS (
  UPDATE assignments a
  SET status = 'cancelled',
      completed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  FROM active
  WHERE a.id = active.id
  RETURNING a.id, a.project_id, a.run_id
)
SELECT
  updated.id AS assignment_id,
  updated.project_id,
  updated.run_id,
  active.from_status,
  'cancelled'::text AS to_status
FROM updated
JOIN active ON active.id = updated.id;
--> statement-breakpoint

INSERT INTO assignment_events (
  id,
  assignment_id,
  project_id,
  run_id,
  event_kind,
  actor_id,
  from_status,
  to_status,
  payload,
  created_at
)
SELECT
  gen_random_uuid()::text,
  closed.assignment_id,
  closed.project_id,
  closed.run_id,
  'system_closed',
  NULL,
  closed.from_status,
  closed.to_status,
  jsonb_build_object(
    'reason', 'legacy_steps_engine_3_cutover',
    'source', 'upgrade_cutover'
  ),
  clock_timestamp()
FROM _m93_closed_assignments closed;
--> statement-breakpoint

UPDATE run_sessions rs
SET acp_session_id = NULL,
    updated_at = clock_timestamp()
FROM _m93_cutover_candidates c
WHERE rs.run_id = c.run_id
  AND rs.acp_session_id IS NOT NULL;
--> statement-breakpoint

CREATE TEMP TABLE _m93_cutover_winners ON COMMIT DROP AS
WITH updated AS (
  UPDATE runs r
  SET status = 'Failed',
      ended_at = clock_timestamp(),
      current_step_id = NULL,
      checkpoint_at = NULL,
      keepalive_until = NULL,
      resume_started_at = NULL,
      resume_requested_at = NULL,
      resume_target_step_id = NULL,
      review_entered_at = NULL
  FROM _m93_cutover_candidates c
  WHERE r.id = c.run_id
    AND r.status = c.prior_status
  RETURNING
    r.id,
    r.project_id,
    r.task_id,
    r.flow_id,
    r.parent_run_id,
    r.ended_at
)
SELECT
  updated.id AS run_id,
  updated.project_id,
  updated.task_id,
  updated.flow_id,
  updated.parent_run_id,
  candidate.prior_status,
  updated.ended_at
FROM updated
JOIN _m93_cutover_candidates candidate
  ON candidate.run_id = updated.id;
--> statement-breakpoint

INSERT INTO domain_events (
  kind,
  project_id,
  task_id,
  run_id,
  actor_type,
  actor_id,
  payload,
  occurred_at
)
SELECT
  'run.failed',
  winner.project_id,
  winner.task_id,
  winner.run_id,
  'system',
  NULL,
  jsonb_build_object(
    'runId', winner.run_id,
    'taskId', winner.task_id,
    'flowId', winner.flow_id,
    'runKind', 'flow',
    'parentRunId', winner.parent_run_id,
    'priorStatus', winner.prior_status,
    'reason', 'legacy_steps_engine_3_cutover',
    'source', 'upgrade_cutover'
  ),
  winner.ended_at
FROM _m93_cutover_winners winner;
--> statement-breakpoint

INSERT INTO webhook_events (
  id,
  project_id,
  run_id,
  type,
  data,
  payload,
  occurred_at
)
SELECT
  gen_random_uuid()::text,
  winner.project_id,
  winner.run_id,
  'run.failed',
  jsonb_build_object('errorCode', 'CONFIG'),
  NULL,
  winner.ended_at
FROM _m93_cutover_winners winner;
--> statement-breakpoint

DROP TABLE step_runs CASCADE;
