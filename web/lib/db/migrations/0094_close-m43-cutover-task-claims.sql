-- M43 follow-up: 0093 terminalizes legacy Flow runs while services are stopped.
-- A C2 claim made immediately before the upgrade is otherwise left on the task,
-- permanently excluding it from the scheduler after restart. Only clear claims
-- that predate the recorded D2 transition; a later human re-triage remains intact.
WITH cutover_tasks AS (
  SELECT
    de.task_id,
    MAX(de.occurred_at) AS cutover_occurred_at
  FROM domain_events de
  WHERE de.kind = 'run.failed'
    AND de.task_id IS NOT NULL
    AND de.payload->>'reason' = 'legacy_steps_engine_3_cutover'
    AND de.payload->>'source' = 'upgrade_cutover'
  GROUP BY de.task_id
)
UPDATE tasks t
SET
  queue_claimed_at = NULL,
  updated_at = clock_timestamp()
FROM cutover_tasks c
WHERE t.id = c.task_id
  AND t.queue_claimed_at IS NOT NULL
  AND t.queue_claimed_at <= c.cutover_occurred_at;
